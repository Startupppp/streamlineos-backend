import { z } from "zod";

export const reportQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM"),
  format: z.enum(["json", "csv"]).default("json"),
  department: z.string().optional(),
  costCenter: z.string().optional(),
  workerType: z.string().optional(),
});

export const calendarQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const createCalendarEventSchema = z.object({
  type: z.string(),
  date: z.string(),
  title: z.string().min(1).max(200),
  month: z.string().optional(),
});

export const patchCalendarEventSchema = createCalendarEventSchema.partial();

export const accountingMappingSchema = z.object({
  componentId: z.number().int().optional(),
  category: z.string().optional(),
  ledgerName: z.string().min(1),
  costCenterSource: z.string().optional(),
  notes: z.string().optional(),
});

export const taxWindowSchema = z.object({
  financialYear: z.string(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  proofDeadline: z.string().datetime().optional(),
  lockDate: z.string().optional(),
  status: z.enum(["DRAFT", "OPEN", "CLOSED", "LOCKED"]).optional(),
});

export const patchTaxWindowSchema = taxWindowSchema.partial();

export const declarationApproveSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

export const essLoanSchema = z.object({
  amount: z.number().min(1000).max(10000000),
  reason: z.string().min(1).max(500),
  totalEmis: z.number().int().min(1).max(360),
});

export const essReimbursementSchema = z.object({
  category: z.string().min(1),
  amount: z.number().positive(),
  description: z.string().min(1).max(1000),
  receiptUrl: z.string().url().optional(),
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

export const essTaxDeclarationSchema = z.object({
  financialYear: z.string(),
  regime: z.enum(["OLD", "NEW"]),
  hra: z.number().min(0).optional(),
  lta: z.number().min(0).optional(),
  section80c: z.number().min(0).optional(),
  section80d: z.number().min(0).optional(),
  section80g: z.number().min(0).optional(),
  homeLoanInterest: z.number().min(0).optional(),
});

export const essTaxProofSchema = z.object({
  declarationId: z.number().int(),
  category: z.string().min(1),
  amount: z.number().positive(),
  description: z.string().optional(),
  proofUrl: z.string().url().optional(),
});

export const fnfApproveSchema = z.object({
  status: z.enum(["PENDING_APPROVAL", "APPROVED", "PAID", "DRAFT"]),
  notes: z.string().optional(),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;
export type PatchCalendarEvent = z.infer<typeof patchCalendarEventSchema>;
export type AccountingMapping = z.infer<typeof accountingMappingSchema>;
export type TaxWindow = z.infer<typeof taxWindowSchema>;
export type PatchTaxWindow = z.infer<typeof patchTaxWindowSchema>;
export type DeclarationApprove = z.infer<typeof declarationApproveSchema>;
export type EssLoan = z.infer<typeof essLoanSchema>;
export type EssReimbursement = z.infer<typeof essReimbursementSchema>;
export type EssBank = z.output<typeof essBankSchema>;
export type EssTaxDeclaration = z.infer<typeof essTaxDeclarationSchema>;
export type EssTaxProof = z.infer<typeof essTaxProofSchema>;
export type FnfApprove = z.infer<typeof fnfApproveSchema>;
