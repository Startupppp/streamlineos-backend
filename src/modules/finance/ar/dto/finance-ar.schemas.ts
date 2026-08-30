import { z } from "zod";
import { idCursorSchema } from "../../../../common/pagination/cursor.schema";
import { pageNumberField, pageSizeField, optionalPageNumberField, optionalPageSizeField } from "../../../../common/pagination/list-query.schema";

export const listCreditNotesSchema = z.object({
  status: z.enum(["DRAFT", "POSTED", "APPLIED", "VOID"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
  page: pageNumberField,
  pageSize: pageSizeField(50, 100),
});

const cnItemSchema = z.object({
  description: z.string().min(1),
  hsnSacCode: z.string().optional(),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  gstRate: z.number().refine((v) => [0, 5, 12, 18, 28].includes(v), {
    message: "gstRate must be 0/5/12/18/28",
  }),
});

export const createCreditNoteSchema = z.object({
  clientId: z.number().int().positive().optional(),
  invoiceId: z.number().int().positive().optional(),
  reason: z.string().optional(),
  currency: z.string().default("INR"),
  items: z.array(cnItemSchema).min(1),
  placeOfSupply: z.string().regex(/^\d{2}$/).optional(),
  customerGstin: z.string().optional(),
  supplierGstin: z.string().optional(),
  notes: z.string().optional(),
});

export const applyCreditNoteSchema = z.object({
  invoiceId: z.number().int().positive(),
  amount: z.number().positive(),
});

export const listRecurringTemplatesSchema = z.object({
  isActive: z
    .string()
    .transform((v) => v === "true")
    .optional(),
  page: pageNumberField,
  pageSize: pageSizeField(50, 100),
});

export const createRecurringTemplateSchema = z.object({
  name: z.string().min(1),
  clientId: z.number().int().positive().optional(),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
  nextRunDate: z.string().optional(),
  endDate: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const updateRecurringTemplateSchema = createRecurringTemplateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const listReminderPoliciesSchema = z.object({
  page: optionalPageNumberField(),
  pageSize: optionalPageSizeField(100),
  limit: optionalPageSizeField(100),
  cursor: idCursorSchema,
});

export const createReminderPolicySchema = z.object({
  name: z.string().min(1),
  offsets: z.array(z.number().int()),
  channel: z.enum(["EMAIL", "WHATSAPP"]).default("EMAIL"),
  template: z.string().optional(),
});

export const updateReminderPolicySchema = createReminderPolicySchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const listReminderLogSchema = z.object({
  invoiceId: z.coerce.number().int().positive().optional(),
  page: optionalPageNumberField(),
  pageSize: optionalPageSizeField(100),
  limit: optionalPageSizeField(100),
  cursor: idCursorSchema,
});

export const customerStatementSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

export const listCollectionActivitiesSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  page: pageNumberField,
  pageSize: pageSizeField(50, 100),
});

export const createCollectionActivitySchema = z.object({
  clientId: z.number().int().positive(),
  invoiceId: z.number().int().positive().optional(),
  type: z.enum(["NOTE", "PROMISE_TO_PAY", "CALL", "EMAIL"]),
  note: z.string().optional(),
  promisedDate: z.string().optional(),
});

export const updateInvoiceCollectionSchema = z
  .object({
    collectionOwnerId: z.string().optional(),
    promiseToPayDate: z.string().optional(),
  })
  .refine((v) => v.collectionOwnerId !== undefined || v.promiseToPayDate !== undefined, {
    message: "At least one field must be provided",
  });

export type ListCreditNotesInput = z.infer<typeof listCreditNotesSchema>;
export type ListCreditNotesQuery = ListCreditNotesInput;
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;
export type ApplyCreditNoteInput = z.infer<typeof applyCreditNoteSchema>;
export type ListRecurringTemplatesInput = z.infer<typeof listRecurringTemplatesSchema>;
export type ListRecurringTemplatesQuery = ListRecurringTemplatesInput;
export type CreateRecurringTemplateInput = z.infer<typeof createRecurringTemplateSchema>;
export type UpdateRecurringTemplateInput = z.infer<typeof updateRecurringTemplateSchema>;
export type ListReminderPoliciesInput = z.infer<typeof listReminderPoliciesSchema>;
export type ListReminderPoliciesQuery = ListReminderPoliciesInput;
export type CreateReminderPolicyInput = z.infer<typeof createReminderPolicySchema>;
export type UpdateReminderPolicyInput = z.infer<typeof updateReminderPolicySchema>;
export type ListReminderLogInput = z.infer<typeof listReminderLogSchema>;
export type ListReminderLogQuery = ListReminderLogInput;
export type CustomerStatementInput = z.infer<typeof customerStatementSchema>;
export type CustomerStatementQuery = CustomerStatementInput;
export type ListCollectionActivitiesInput = z.infer<typeof listCollectionActivitiesSchema>;
export type ListCollectionActivitiesQuery = ListCollectionActivitiesInput;
export type CreateCollectionActivityInput = z.infer<typeof createCollectionActivitySchema>;
export type UpdateInvoiceCollectionInput = z.infer<typeof updateInvoiceCollectionSchema>;

export const listArPaymentsSchema = z.object({
  method: z.enum(["bank_transfer", "upi", "cheque", "cash", "card", "other"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: pageNumberField,
  pageSize: pageSizeField(50, 100),
});

export type ListArPaymentsInput = z.infer<typeof listArPaymentsSchema>;
export type ListArPaymentsQuery = ListArPaymentsInput;
