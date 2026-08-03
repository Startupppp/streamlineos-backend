import { z } from "zod";

export const exceptionsQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
  severity: z.enum(["WARNING", "ERROR"]).optional(),
  rule: z.string().max(100).optional(),
  userId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
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
