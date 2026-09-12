import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import { complianceStatusEnum, complianceTransportEnum } from "../../../../db/schema";

/**
 * What the compliance surface says about a document's reporting duty.
 *
 * The narrative fields (`headline`, `filed`, `action`) are `describe()`'s
 * answer spread onto the row. On the submit route they are spread from the row
 * the adapter wrote, which is found rather than assumed — so they are optional
 * there and required on each `states` entry.
 */

/** `ComplianceTransportRegistry.describe()` — the deployment's own connection. */
const transportDescriptionSchema = z.object({
  configured: z.boolean(),
  real: z.boolean(),
  name: z.string(),
});

const narrativeSchema = z.object({
  headline: z.string(),
  filed: z.boolean(),
  action: z.string().nullable(),
});

const authorityErrorSchema = z.object({ code: z.string(), message: z.string() });

export const documentComplianceResponseSchema = z.object({
  states: z.array(
    narrativeSchema.extend({
      transport: z.enum(complianceTransportEnum.enumValues),
      status: z.enum(complianceStatusEnum.enumValues),
      authorityId: z.string().nullable(),
      ackNo: z.string().nullable(),
      ackAt: nullableWireDate(),
      errors: z.array(authorityErrorSchema).nullable(),
      cancelledAt: nullableWireDate(),
    }),
  ),
  /** True only when a transport that actually files says so. */
  filed: z.boolean(),
  headline: z.string(),
  transport: transportDescriptionSchema,
});

/**
 * The adapter's verdict. `accepted` is the only outcome that may become a
 * filing, and only with an identifier from the authority in hand.
 */
const transportResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    authorityId: z.string(),
    ackNo: z.string(),
    ackAt: wireDate(),
  }),
  z.object({
    outcome: z.literal("rejected"),
    errors: z.array(authorityErrorSchema),
  }),
  z.object({ outcome: z.literal("unavailable"), reason: z.string() }),
]);

export const submitDocumentResponseSchema = z.object({
  result: transportResultSchema,
  transport: transportDescriptionSchema,
  headline: z.string().optional(),
  filed: z.boolean().optional(),
  action: z.string().nullable().optional(),
});
