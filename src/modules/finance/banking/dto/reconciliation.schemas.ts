import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const confirmMatchSchema = z.object({
  transactionId: z.number().int().positive(),
  matchType: z.enum([
    "CUSTOMER_PAYMENT",
    "VENDOR_PAYMENT",
    "MANUAL_JOURNAL",
    "BANK_FEE",
    "TRANSFER",
  ]),
  matchedRecordId: z.number().int().positive().optional(),
  counterAccountId: z.number().int().positive().optional(),
  memo: z.string().max(500).optional(),
}).strict();

export const unmatchSchema = z.object({
  transactionId: z.number().int().positive(),
}).strict();

export const ignoreTransactionSchema = z.object({
  transactionId: z.number().int().positive(),
}).strict();

export const ruleConditionSchema = z.object({
  field: z.enum(["description", "counterparty", "amount"]),
  op: z.enum(["contains", "equals", "gt", "lt"]),
  value: z.string().min(1),
});

export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("categorize"),
    accountPurposeOrId: z.string().or(z.number()),
    memo: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal("transfer") }),
  z.object({ type: z.literal("fee") }),
]);

export const createReconciliationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  priority: z.number().int().min(0).default(0),
  conditions: z.array(ruleConditionSchema).min(1),
  action: ruleActionSchema,
  isActive: z.boolean().default(true),
}).strict();

export type ConfirmMatchInput = z.infer<typeof confirmMatchSchema>;
export type UnmatchInput = z.infer<typeof unmatchSchema>;
export type IgnoreTransactionInput = z.infer<typeof ignoreTransactionSchema>;
export type CreateReconciliationRuleInput = z.infer<typeof createReconciliationRuleSchema>;

export const rulesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});
export type RulesQuery = z.infer<typeof rulesQuerySchema>;
