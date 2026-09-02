import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listJobsQuerySchema = z.object({
  failedOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  runId: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
}).strict();
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const enqueueJobSchema = z.object({
  jobType: z.enum(["GENERATE", "RECALCULATE", "PDF_PUBLISH", "FILING_EXPORT"]),
  runId: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();
export type EnqueueJobInput = z.infer<typeof enqueueJobSchema>;
