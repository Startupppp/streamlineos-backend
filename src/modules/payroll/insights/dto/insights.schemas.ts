import { z } from "zod";

export const createCalendarEventSchema = z.object({
  type: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  title: z.string().min(1).max(200),
  month: z.string().optional(),
});

export const patchCalendarEventSchema = createCalendarEventSchema.partial();

export const accountingMappingCreateSchema = z.object({
  componentId: z.number().int().optional(),
  category: z.string().optional(),
  ledgerName: z.string().min(1),
  costCenterSource: z.string().optional(),
  notes: z.string().optional(),
}).superRefine((data, ctx) => {
  const hasComponent = data.componentId !== undefined;
  const hasCategory = data.category !== undefined;
  if (hasComponent === hasCategory) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of componentId or category must be provided",
      path: [],
    });
  }
});

export const accountingMappingUpdateSchema = z.object({
  componentId: z.number().int().nullable().optional(),
  category: z.string().nullable().optional(),
  ledgerName: z.string().min(1).optional(),
  costCenterSource: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const essBankSchema = z.object({
  accountNumber: z.string().min(8).max(34),
  bankName: z.string().min(1).max(100),
  branch: z.string().min(1).max(100),
  ifsc: z.string().max(50).optional(),
  code: z.string().max(50).optional(),
  accountHolder: z.string().min(1).max(100),
  accountHolderName: z.string().max(100).optional(),
  pfUanNumber: z.string().max(30).optional(),
  bankCountry: z.string().length(2).toUpperCase().optional(),
}).superRefine((data, ctx) => {
  const effectiveCode = data.code ?? data.ifsc ?? "";
  if (!effectiveCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Bank code (IFSC / routing / sort code / IBAN) is required",
      path: ["code"],
    });
  }
});

export const essCreateReimbursementSchema = z.object({
  category: z.string().min(1).max(100),
  amount: z.number().positive().max(999999),
  description: z.string().max(1000).optional(),
  receiptUrl: z.string().url().optional().or(z.literal("")).optional(),
  payrollMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});
export type EssCreateReimbursement = z.infer<typeof essCreateReimbursementSchema>;

export const essCreateLoanSchema = z.object({
  amount: z.number().min(1000).max(10000000),
  reason: z.string().min(1).max(500),
  totalEmis: z.number().int().min(1).max(360),
});
export type EssCreateLoan = z.infer<typeof essCreateLoanSchema>;

export const essSubmitTaxDeclarationSchema = z.object({
  financialYear: z.string().min(1).max(20),
  regime: z.enum(["OLD", "NEW"]),
  hra: z.number().nonnegative().optional(),
  lta: z.number().nonnegative().optional(),
  section80c: z.number().nonnegative().optional(),
  section80d: z.number().nonnegative().optional(),
  section80g: z.number().nonnegative().optional(),
  homeLoanInterest: z.number().nonnegative().optional(),
});
export type EssSubmitTaxDeclaration = z.infer<typeof essSubmitTaxDeclarationSchema>;

export const essAddTaxProofSchema = z.object({
  declarationId: z.number().int().positive(),
  category: z.string().min(1).max(100),
  amount: z.number().nonnegative(),
  description: z.string().max(500).optional(),
  proofUrl: z.string().url().optional(),
});
export type EssAddTaxProof = z.infer<typeof essAddTaxProofSchema>;

export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;
export type PatchCalendarEvent = z.infer<typeof patchCalendarEventSchema>;
export type AccountingMappingCreate = z.infer<typeof accountingMappingCreateSchema>;
export type AccountingMappingUpdate = z.infer<typeof accountingMappingUpdateSchema>;
export type EssBank = z.output<typeof essBankSchema>;

export const journalBatchCreateSchema = z.object({
  periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "periodKey must be YYYY-MM"),
  allowProvisional: z.boolean().optional(),
  note: z.string().max(500).optional(),
});
export type JournalBatchCreate = z.infer<typeof journalBatchCreateSchema>;

export const journalBatchReverseSchema = z.object({
  reason: z.string().min(1, "A reversal reason is required").max(500),
});
export type JournalBatchReverse = z.infer<typeof journalBatchReverseSchema>;

export const journalBatchReconcileSchema = z.object({
  status: z.enum(["UNRECONCILED", "RECONCILED", "DISPUTED"]),
  note: z.string().max(500).optional(),
});
export type JournalBatchReconcile = z.infer<typeof journalBatchReconcileSchema>;

export const journalBatchListQuerySchema = z.object({
  periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  status: z.enum(["DRAFT", "POSTED", "EXPORTED", "REVERSED", "FAILED"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type JournalBatchListQuery = z.infer<typeof journalBatchListQuerySchema>;
