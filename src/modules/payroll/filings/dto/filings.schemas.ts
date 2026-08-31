import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const prepareFilingSchema = z.object({
  filingType: z.enum(["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"]),
  periodId: z.number().int().positive().optional(),
  entityId: z.number().int().positive().optional(),
  fiscalYear: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  ruleVersion: z.string().optional(),
  /** Prefer month of REGULAR run when runId omitted. */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  runId: z.number().int().positive().optional(),
});
export type PrepareFilingInput = z.infer<typeof prepareFilingSchema>;

export const attachAcknowledgementSchema = z.object({
  challanRef: z.string().max(120).optional(),
  acknowledgementRef: z.string().max(120).optional(),
});
export type AttachAcknowledgementInput = z.infer<typeof attachAcknowledgementSchema>;

export const listFilingsQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});
export type ListFilingsQuery = z.infer<typeof listFilingsQuerySchema>;
