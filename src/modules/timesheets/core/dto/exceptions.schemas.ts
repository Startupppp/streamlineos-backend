import { z } from "zod";
import {
  timesheetExceptionSeveritySchema,
  timesheetExceptionStatusSchema,
} from "./status.schemas";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const exceptionsQuerySchema = z.object({
  status: timesheetExceptionStatusSchema.optional(),
  severity: timesheetExceptionSeveritySchema.optional(),
  rule: z.string().max(100).optional(),
  userId: z.string().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
});
export type ExceptionsQuery = z.infer<typeof exceptionsQuerySchema>;

export const resolveExceptionSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

export const dismissExceptionSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type DismissExceptionInput = z.infer<typeof dismissExceptionSchema>;
