import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const columnMappingSchema = z.object({
  date: z.number().int().min(0),
  description: z.number().int().min(0),
  amount: z.number().int().min(0).optional(),
  debit: z.number().int().min(0).optional(),
  credit: z.number().int().min(0).optional(),
  reference: z.number().int().min(0).optional(),
  counterparty: z.number().int().min(0).optional(),
}).refine(
  (m) => m.amount !== undefined || (m.debit !== undefined && m.credit !== undefined),
  { message: "columnMapping must have either 'amount' or both 'debit' and 'credit'" },
);

export const createBankImportSchema = z.object({
  bankAccountId: z.number().int().positive(),
  fileName: z.string().min(1).max(255),
  columnMapping: columnMappingSchema,
  rows: z.array(z.array(z.string())).min(1).max(2000),
  dateFormat: z.string().min(1).max(50).default("YYYY-MM-DD"),
  hasHeaderRow: z.boolean().default(false),
}).strict();

export const bankImportsQuerySchema = z.object({
  bankAccountId: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export type CreateBankImportInput = z.infer<typeof createBankImportSchema>;
export type BankImportsQuery = z.infer<typeof bankImportsQuerySchema>;
