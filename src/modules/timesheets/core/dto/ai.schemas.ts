import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const describeEntrySchema = z.object({
  description: z.string().min(1).max(2000),
  projectName: z.string().max(200).optional(),
  ticketTitle: z.string().max(300).optional(),
  hours: z.number().positive().max(24).optional(),
  billable: z.boolean().optional(),
}).strict();
export type DescribeEntryInput = z.infer<typeof describeEntrySchema>;

export const billingNarrativeSchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  startDate: dateString,
  endDate: dateString,
}).strict();
export type BillingNarrativeInput = z.infer<typeof billingNarrativeSchema>;

export const rejectionDraftSchema = z.object({
  note: z.string().max(1000).optional(),
}).strict();
export type RejectionDraftInput = z.infer<typeof rejectionDraftSchema>;
