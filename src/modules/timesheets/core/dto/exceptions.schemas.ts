import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const exceptionsQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
  severity: z.enum(["WARNING", "ERROR"]).optional(),
  rule: z.string().max(100).optional(),
  userId: z.string().optional(),
  page: pageNumberField,
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
