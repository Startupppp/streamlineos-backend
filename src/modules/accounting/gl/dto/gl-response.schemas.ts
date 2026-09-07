import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const glLineItemSchema = z.object({
  lineId: z.number().int(),
  entryId: z.number().int(),
  entryNumber: z.string(),
  entryDate: z.string().nullable(),
  accountId: z.number().int(),
  accountCode: z.string(),
  accountName: z.string(),
  debit: z.string(),
  credit: z.string(),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  clientId: z.number().int().nullable(),
  vendorId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  departmentId: z.number().int().nullable(),
  runningBalance: z.string(),
});

export const generalLedgerResponseSchema = z.object({
  openingBalance: z.string(),
  closingBalance: z.string(),
  items: z.array(glLineItemSchema),
  nextCursor: z.string().nullable(),
});

export const glAccountActivitySchema = z.object({
  accountId: z.number().int(),
  code: z.string(),
  name: z.string(),
  accountType: z.string(),
  periodDebit: z.string(),
  periodCredit: z.string(),
  netActivity: z.string(),
});

export const glAccountsWithActivityResponseSchema = z.array(glAccountActivitySchema);

export const journalApprovalSubmitResponseSchema = z.object({
  entryId: z.number().int(),
  status: z.string(),
});

export const journalApprovalDecisionResponseSchema = z.object({
  entryId: z.number().int(),
  decision: z.string(),
  entryStatus: z.string(),
});

const periodSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.string(),
  closedByMembershipId: z.number().int().nullable(),
  closedAt: nullableWireDate(),
  lockedByMembershipId: z.number().int().nullable(),
  lockedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const periodListResponseSchema = z.array(periodSchema);

export const generatePeriodsResponseSchema = z.object({
  created: z.number().int(),
  total: z.number().int(),
});

const checklistItemSchema = z.object({
  passed: z.boolean(),
  count: z.number().int(),
});

export const periodCloseChecklistResponseSchema = z.object({
  period: periodSchema,
  checklist: z.object({
    noDraftJournals: checklistItemSchema,
    noDraftBills: checklistItemSchema,
    noUnreconciledTransactions: checklistItemSchema,
    noPendingApprovals: checklistItemSchema,
  }),
  canClose: z.boolean(),
});

export const periodMutationResponseSchema = periodSchema;

export const reopenPeriodResponseSchema = z.object({
  id: z.number().int(),
  status: z.string(),
});

const recurringTemplateLineSchema = z.record(z.string(), z.unknown());

export const recurringJournalTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  frequency: z.string(),
  nextRunDate: z.string().nullable(),
  lastRunDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isActive: z.boolean(),
  lines: z.array(recurringTemplateLineSchema),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const recurringJournalListResponseSchema = z.object({
  data: z.array(recurringJournalTemplateSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const recurringJournalDeleteResponseSchema = z.object({
  id: z.number().int(),
  deleted: z.boolean(),
});

export const recurringJournalRunNowResponseSchema = z.object({
  id: z.number().int(),
  entryNumber: z.string(),
});
