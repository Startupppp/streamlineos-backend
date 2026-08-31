import { z } from "zod";

export const GDPR_EXPORT_REQUESTED_EVENT = "gdpr.export.requested";
export const GDPR_EXPORT_AGGREGATE_TYPE = "gdpr_export_job";

export const gdprExportRequestedPayloadSchema = z.object({
  jobId: z.string().uuid(),
  orgId: z.string().min(1),
});

export type GdprExportRequestedPayload = z.infer<typeof gdprExportRequestedPayloadSchema>;
