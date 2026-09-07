import { z } from "zod";
import {
  optionalPageNumberField,
  optionalPageSizeField,
} from "../../../../common/pagination/list-query.schema";
import { payrollCalendarEventTypeEnum, payrollWorkerTypeEnum } from "../../../../db/schema";

const workerTypeFilterSchema = z.enum(payrollWorkerTypeEnum.enumValues);

export const createCalendarEventSchema = z.object({
  type: z.enum(payrollCalendarEventTypeEnum.enumValues),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  title: z.string().min(1).max(200),
  month: z.string().optional(),
}).strict();

export const patchCalendarEventSchema = createCalendarEventSchema.partial().strict();

export const accountingMappingCreateSchema = z
  .object({
    componentId: z.number().int().optional(),
    category: z.string().optional(),
    ledgerName: z.string().min(1),
    costCenterSource: z.string().optional(),
    notes: z.string().optional(),
  }).strict()
  .superRefine((data, ctx) => {
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
}).strict();

export const essBankSchema = z
  .object({
    accountNumber: z.string().min(8).max(34),
    bankName: z.string().min(1).max(100),
    branch: z.string().min(1).max(100),
    ifsc: z.string().max(50).optional(),
    code: z.string().max(50).optional(),
    accountHolder: z.string().min(1).max(100),
    accountHolderName: z.string().max(100).optional(),
    pfUanNumber: z.string().max(30).optional(),
    bankCountry: z.string().length(2).toUpperCase().optional(),
  }).strict()
  .superRefine((data, ctx) => {
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
  payrollMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
}).strict();
export type EssCreateReimbursement = z.infer<
  typeof essCreateReimbursementSchema
>;

export const essCreateLoanSchema = z.object({
  amount: z.number().min(1000).max(10000000),
  reason: z.string().min(1).max(500),
  totalEmis: z.number().int().min(1).max(360),
}).strict();
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
}).strict();
export type EssSubmitTaxDeclaration = z.infer<
  typeof essSubmitTaxDeclarationSchema
>;

export const essAddTaxProofSchema = z.object({
  declarationId: z.number().int().positive(),
  category: z.string().min(1).max(100),
  amount: z.number().nonnegative(),
  description: z.string().max(500).optional(),
  proofUrl: z.string().url().optional(),
}).strict();
export type EssAddTaxProof = z.infer<typeof essAddTaxProofSchema>;

export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;
export type PatchCalendarEvent = z.infer<typeof patchCalendarEventSchema>;
export type AccountingMappingCreate = z.infer<
  typeof accountingMappingCreateSchema
>;
export type AccountingMappingUpdate = z.infer<
  typeof accountingMappingUpdateSchema
>;
export type EssBank = z.output<typeof essBankSchema>;

export const journalBatchCreateSchema = z.object({
  periodKey: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "periodKey must be YYYY-MM"),
  allowProvisional: z.boolean().optional(),
  note: z.string().max(500).optional(),
}).strict();
export type JournalBatchCreate = z.infer<typeof journalBatchCreateSchema>;

export const journalBatchReverseSchema = z.object({
  reason: z.string().min(1, "A reversal reason is required").max(500),
}).strict();
export type JournalBatchReverse = z.infer<typeof journalBatchReverseSchema>;

export const journalBatchReconcileSchema = z.object({
  status: z.enum(["UNRECONCILED", "RECONCILED", "DISPUTED"]),
  note: z.string().max(500).optional(),
}).strict();
export type JournalBatchReconcile = z.infer<typeof journalBatchReconcileSchema>;

export const journalBatchListQuerySchema = z.object({
  periodKey: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  status: z
    .enum(["DRAFT", "POSTED", "EXPORTED", "REVERSED", "FAILED"])
    .optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: optionalPageSizeField(),
}).strict();
export type JournalBatchListQuery = z.infer<typeof journalBatchListQuerySchema>;

export const periodReconQuerySchema = z.object({
  periodKey: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "periodKey must be YYYY-MM"),
}).strict();
export type PeriodReconQuery = z.infer<typeof periodReconQuerySchema>;

export const managerRejectSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type ManagerReject = z.infer<typeof managerRejectSchema>;

export const rejectDeclarationSchema = z.object({
  note: z.string().max(500).optional(),
}).strict();
export type RejectDeclarationInput = z.infer<typeof rejectDeclarationSchema>;

export const taxDeclarationsQuerySchema = z.object({
  financialYear: z.string().trim().max(20).optional(),
  status: z.string().trim().max(30).optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: optionalPageSizeField(),
}).strict();
export type TaxDeclarationsQuery = z.infer<typeof taxDeclarationsQuerySchema>;

export const journalQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  format: z.enum(["json", "csv"]).optional(),
}).strict();
export type JournalQuery = z.infer<typeof journalQuerySchema>;

export const reportsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  format: z.enum(["json", "csv"]).optional(),
  department: z.string().trim().max(100).optional(),
  costCenter: z.string().trim().max(100).optional(),
  workerType: workerTypeFilterSchema.optional(),
  limit: optionalPageSizeField(),
  cursor: z.string().trim().min(1).max(2048).optional(),
}).strict();
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
