import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const exceptionsQuerySchema = z
  .object({
    status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
    severity: z.enum(["WARNING", "ERROR"]).optional(),
    rule: z.string().max(100).optional(),
    userId: z.string().optional(),
    cursor: z.string().optional(),
    limit: pageSizeField(50, 100),
  })
  .strict();
export type ExceptionsQuery = z.infer<typeof exceptionsQuerySchema>;

export const resolveExceptionSchema = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

export const dismissExceptionSchema = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();
export type DismissExceptionInput = z.infer<typeof dismissExceptionSchema>;
