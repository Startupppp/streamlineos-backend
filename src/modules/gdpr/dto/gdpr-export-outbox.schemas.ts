import { z } from "zod";

export const GDPR_EXPORT_REQUESTED_EVENT = "gdpr.export.requested";
export const GDPR_EXPORT_AGGREGATE_TYPE = "gdpr_export_job";

/**
 * Closed at the boundary on purpose. A bare `z.object({})` strips an unexpected key
 * instead of rejecting it, so a producer that renamed `orgId` would parse clean and hand
 * the consumer a payload whose tenant field is simply absent — the exact shape that turns
 * a dropped field into a wrong-subject write rather than an error.
 */
export const gdprExportRequestedPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    orgId: z.string().min(1),
  })
  .strict();

export type GdprExportRequestedPayload = z.infer<typeof gdprExportRequestedPayloadSchema>;
