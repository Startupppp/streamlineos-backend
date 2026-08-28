import { z } from "zod";

export const EXPENSE_SUBMITTED_EVENT = "expense.submitted";
export const EXPENSE_DECIDED_EVENT = "expense.decided";

export const EXPENSE_AGGREGATE_TYPE = "expense";

export const expenseSubmittedRecipientsSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("EXPLICIT"),
    userIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({ mode: z.literal("EXPENSE_APPROVERS") }),
]);

export const expenseSubmittedPayloadSchema = z.object({
  expenseId: z.number().int().positive(),
  orgId: z.string().min(1),
  actorUserId: z.string().min(1),
  amount: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  recipients: expenseSubmittedRecipientsSchema,
  runAutomations: z.boolean(),
});

export const expenseDecidedPayloadSchema = z.object({
  expenseId: z.number().int().positive(),
  orgId: z.string().min(1),
  actorUserId: z.string().min(1),
  recipientUserId: z.string().min(1),
  status: z.enum(["APPROVED", "REJECTED", "PAID"]),
  amount: z.string(),
  category: z.string(),
  rejectionReason: z.string().nullable(),
  journalEntryId: z.number().int().positive().nullable(),
});

export type ExpenseSubmittedPayload = z.infer<typeof expenseSubmittedPayloadSchema>;
export type ExpenseDecidedPayload = z.infer<typeof expenseDecidedPayloadSchema>;

export type ExpenseDecisionStatus = ExpenseDecidedPayload["status"];

const DECISION_EVENT_KEYS = {
  APPROVED: "accounting.expense.approved",
  REJECTED: "accounting.expense.rejected",
  PAID: "accounting.reimbursement.paid",
} as const;

export function decisionEventKey(
  status: ExpenseDecisionStatus,
): (typeof DECISION_EVENT_KEYS)[ExpenseDecisionStatus] {
  return DECISION_EVENT_KEYS[status];
}

export function expenseAggregateVersion(row: {
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
}): number {
  const stamp = row.updatedAt ?? row.createdAt;
  if (stamp === null || stamp === undefined) return Date.now();
  const parsed = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}
