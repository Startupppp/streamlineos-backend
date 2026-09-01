import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const glQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  clientId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  departmentId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
  format: z.enum(["json", "csv"]).default("json"),
});

export type GlQuery = z.infer<typeof glQuerySchema>;

export const glAccountsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]).optional(),
});

export type GlAccountsQuery = z.infer<typeof glAccountsQuerySchema>;
