import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const recurringLineSchema = z.object({
  accountId: z.number().int().positive(),
  debit: z.number().min(0).default(0),
  credit: z.number().min(0).default(0),
  description: z.string().max(500).optional(),
});

export const createRecurringJournalSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
  nextRunDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").optional(),
  lines: z.array(recurringLineSchema).min(2).max(100),
});

export const updateRecurringJournalSchema = createRecurringJournalSchema.partial();

export type CreateRecurringJournalInput = z.infer<typeof createRecurringJournalSchema>;
export type UpdateRecurringJournalInput = z.infer<typeof updateRecurringJournalSchema>;
export type RecurringLine = z.infer<typeof recurringLineSchema>;

export const recurringLineArraySchema = z.array(recurringLineSchema);

export const listRecurringJournalsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50),
});
export type ListRecurringJournalsQuery = z.infer<typeof listRecurringJournalsQuerySchema>;
