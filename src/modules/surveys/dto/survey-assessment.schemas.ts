import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const createAttemptSchema = z.object({
  participantId: z.number().int().positive().optional(),
}).strict();

export const listAttemptsSchema = z.object({
  status: z.enum(["not_started", "in_progress", "submitted", "passed", "failed", "expired"]).optional(),
  page: pageNumberField,
  pageSize: pageSizeField(25, 100),
}).strict();

export type CreateAttemptInput = z.infer<typeof createAttemptSchema>;
export type ListAttemptsInput = z.infer<typeof listAttemptsSchema>;
