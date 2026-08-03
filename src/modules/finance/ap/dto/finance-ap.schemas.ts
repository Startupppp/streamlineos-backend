import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const billApprovalNoteSchema = z.object({
  note: z.string().max(500).optional(),
});

export const billCancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const createVendorCreditItemSchema = z.object({
  description: z.string().min(1).max(255),
  hsnSacCode: z.string().max(20).optional(),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  gstRate: z
    .number()
    .refine((v) => [0, 5, 12, 18, 28].includes(v), { message: "gstRate must be 0/5/12/18/28" }),
});

export const createVendorCreditSchema = z.object({
  vendorId: z.number().int().positive(),
  billId: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
  currency: z.string().length(3).default("INR"),
  items: z.array(createVendorCreditItemSchema).min(1),
});

export const applyVendorCreditSchema = z.object({
  billId: z.number().int().positive(),
  amount: z.number().positive().max(999999999.99),
});

export const listVendorCreditsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  vendorId: z.coerce.number().int().positive().optional(),
  status: z.enum(["DRAFT", "POSTED", "APPLIED", "VOID"]).optional(),
});

export const recurringBillPayloadSchema = z.object({
  vendorId: z.number().int().positive(),
  vendorBillNumber: z.string().max(60).optional(),
  billDate: isoDate,
  dueDate: isoDate.optional(),
  placeOfSupply: z.string().regex(/^\d{2}$/).optional(),
  vendorGstin: z.string().optional(),
  supplierGstin: z.string().optional(),
  reverseCharge: z.boolean().default(false),
  discount: z.number().nonnegative().default(0),
  notes: z.string().max(500).optional(),
  expenseAccountCode: z.string().min(1).max(20).default("5990"),
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(255),
        hsnSacCode: z.string().max(20).optional(),
        quantity: z.number().positive(),
        rate: z.number().nonnegative(),
        gstRate: z
          .number()
          .refine((v) => [0, 5, 12, 18, 28].includes(v), { message: "gstRate must be 0/5/12/18/28" }),
      }),
    )
    .min(1),
});

export const createRecurringBillSchema = z.object({
  name: z.string().min(1).max(120),
  vendorId: z.number().int().positive().optional(),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
  nextRunDate: isoDate.optional(),
  endDate: isoDate.optional(),
  isActive: z.boolean().default(true),
  payload: recurringBillPayloadSchema,
});

export const updateRecurringBillSchema = createRecurringBillSchema.partial();

export const listRecurringBillsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  isActive: z.coerce.boolean().optional(),
});

export const createPaymentRunSchema = z.object({
  name: z.string().min(1).max(120),
  scheduledDate: isoDate.optional(),
  filters: z
    .object({
      vendorIds: z.array(z.number().int().positive()).optional(),
      dueBefore: isoDate.optional(),
      minAmount: z.number().nonnegative().optional(),
      maxAmount: z.number().positive().optional(),
    })
    .optional(),
});

export const updatePaymentRunItemSchema = z.object({
  amount: z.number().positive().max(999999999.99).optional(),
  excluded: z.boolean().optional(),
});

export const listPaymentRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["DRAFT", "APPROVED", "COMPLETED", "CANCELLED"]).optional(),
});

export const manualAllocationSchema = z.object({
  vendorPaymentId: z.number().int().positive(),
  allocations: z
    .array(
      z.object({
        billId: z.number().int().positive(),
        amount: z.number().positive().max(999999999.99),
      }),
    )
    .min(1),
});

export type BillApprovalNote = z.infer<typeof billApprovalNoteSchema>;
export type BillCancel = z.infer<typeof billCancelSchema>;
export type CreateVendorCreditInput = z.infer<typeof createVendorCreditSchema>;
export type ApplyVendorCreditInput = z.infer<typeof applyVendorCreditSchema>;
export type ListVendorCreditsQuery = z.infer<typeof listVendorCreditsQuerySchema>;
export type CreateRecurringBillInput = z.infer<typeof createRecurringBillSchema>;
export type UpdateRecurringBillInput = z.infer<typeof updateRecurringBillSchema>;
export type ListRecurringBillsQuery = z.infer<typeof listRecurringBillsQuerySchema>;
export type CreatePaymentRunInput = z.infer<typeof createPaymentRunSchema>;
export type UpdatePaymentRunItemInput = z.infer<typeof updatePaymentRunItemSchema>;
export type ListPaymentRunsQuery = z.infer<typeof listPaymentRunsQuerySchema>;
export const listVendorPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  vendorId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type ManualAllocationInput = z.infer<typeof manualAllocationSchema>;
export type ListVendorPaymentsQuery = z.infer<typeof listVendorPaymentsQuerySchema>;
