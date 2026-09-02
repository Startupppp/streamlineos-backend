import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const accountTypeSchema = z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);

export const listAccountsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  q: z.string().trim().max(200).optional(),
  type: accountTypeSchema.optional(),
  activeOnly: queryBoolean.optional(),
}).strict();

export const createAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  accountType: accountTypeSchema,
  parentAccountId: z.number().int().positive().optional(),
  description: z.string().max(500).optional(),
}).strict();

export const updateAccountSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  description: z.string().max(500).optional(),
}).strict();

export const journalEntryStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "POSTED",
  "VOID",
]);

export const listJournalQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: pageSizeField(20, 100),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    sourceType: z.string().max(40).optional(),
    status: journalEntryStatusSchema.optional(),
  }).strict()
  .refine((r) => !r.from || !r.to || r.from <= r.to, { message: "`from` must be <= `to`", path: ["from"] });

export const createJournalEntrySchema = z
  .object({
    entryDate: isoDate,
    description: z.string().min(1).max(500),
    status: z.enum(["DRAFT", "POSTED"]).default("DRAFT"),
    lines: z
      .array(
        z
          .object({
            accountCode: z.string().min(1).max(20),
            debit: z.number().nonnegative(),
            credit: z.number().nonnegative(),
            description: z.string().max(500).optional(),
          })
          .refine((line) => (line.debit > 0) !== (line.credit > 0), {
            message: "Each line must have either a debit or a credit amount, not both or neither",
          }),
      )
      .min(2),
  }).strict()
  .refine(
    (entry) => {
      const totalDebit = entry.lines.reduce((sum, l) => sum + l.debit, 0);
      const totalCredit = entry.lines.reduce((sum, l) => sum + l.credit, 0);
      return Math.abs(totalDebit - totalCredit) < 0.01;
    },
    { message: "Journal entry must balance: total debits must equal total credits", path: ["lines"] },
  );

export const trialBalanceQuerySchema = z.object({ asOf: isoDate }).strict();

export const balanceSheetQuerySchema = z.object({ asOf: isoDate }).strict();

export const profitLossQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }).strict()
  .refine((r) => !r.from || !r.to || r.from <= r.to, { message: "`from` must be <= `to`", path: ["from"] });

export const agedReceivablesQuerySchema = z.object({ asOf: isoDate.optional() }).strict();

export const listCustomerLedgerQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
}).strict();

export const listCustomersOutstandingQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  q: z.string().trim().max(200).optional(),
  onlyOutstanding: queryBoolean.optional(),
}).strict();

export const listVendorsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  q: z.string().trim().max(200).optional(),
  onlyOutstanding: queryBoolean.optional(),
}).strict();

export const gstr1QuerySchema = z.object({ from: isoDate, to: isoDate }).strict();

export const gstr3BQuerySchema = z.object({ from: isoDate, to: isoDate }).strict();

export const purchaseBillStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "POSTED",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
]);

export const listPurchaseBillsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  q: z.string().trim().max(200).optional(),
  status: z.preprocess(
    (val) => {
      if (typeof val === "string" && val.includes(",")) {
        return val.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return val;
    },
    z.union([purchaseBillStatusSchema, z.array(purchaseBillStatusSchema)]).optional(),
  ),
  vendorId: z.coerce.number().int().positive().optional(),
}).strict();

export const createPurchaseBillSchema = z.object({
  vendorId: z.number().int().positive(),
  vendorBillNumber: z.string().max(60).optional(),
  billDate: isoDate,
  dueDate: isoDate.optional(),
  status: z.enum(["DRAFT", "POSTED"]).default("DRAFT"),
  placeOfSupply: z.string().regex(/^\d{2}$/).optional(),
  vendorGstin: z.string().regex(gstinRegex).optional().or(z.literal("")),
  supplierGstin: z.string().regex(gstinRegex).optional().or(z.literal("")),
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
}).strict();

export const updatePurchaseBillStatusSchema = z.object({
  status: z.enum(["POSTED", "CANCELLED"]),
}).strict();

export const recordVendorPaymentSchema = z.object({
  amount: z.number().positive().max(999999999.99),
  paymentDate: isoDate,
  paymentMethod: z.enum(["bank_transfer", "upi", "cheque", "cash", "card", "other"]),
  referenceNumber: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
}).strict();

export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ListJournalQuery = z.infer<typeof listJournalQuerySchema>;
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
export type ProfitLossQuery = z.infer<typeof profitLossQuerySchema>;
export type AgedReceivablesQuery = z.infer<typeof agedReceivablesQuerySchema>;
export type ListCustomerLedgerQuery = z.infer<typeof listCustomerLedgerQuerySchema>;
export type ListCustomersOutstandingQuery = z.infer<typeof listCustomersOutstandingQuerySchema>;
export type ListVendorsQuery = z.infer<typeof listVendorsQuerySchema>;
export type Gstr1Query = z.infer<typeof gstr1QuerySchema>;
export type Gstr3BQuery = z.infer<typeof gstr3BQuerySchema>;
export type ListPurchaseBillsQuery = z.infer<typeof listPurchaseBillsQuerySchema>;
export type CreatePurchaseBillInput = z.infer<typeof createPurchaseBillSchema>;
export type UpdatePurchaseBillStatusInput = z.infer<typeof updatePurchaseBillStatusSchema>;
export type RecordVendorPaymentInput = z.infer<typeof recordVendorPaymentSchema>;
