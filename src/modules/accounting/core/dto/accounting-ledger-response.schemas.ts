import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const ledgerAccountSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  code: z.string(),
  name: z.string(),
  accountType: z.string(),
  parentAccountId: z.number().int().nullable(),
  isActive: z.boolean(),
  normalBalance: z.string().nullable(),
  isSystem: z.boolean(),
  description: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: nullableWireDate(),
});

export const ledgerAccountListResponseSchema = cursorPageSchema(ledgerAccountSchema);

const journalEntryRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  entryNumber: z.string(),
  entryDate: z.string(),
  postingDate: z.string().nullable(),
  description: z.string().nullable(),
  periodId: z.number().int().nullable(),
  currency: z.string(),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  sourceEvent: z.string().nullable(),
  status: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  postedBy: z.string().nullable(),
  postedAt: nullableWireDate(),
  reversedEntryId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: nullableWireDate(),
});

export const journalEntryListResponseSchema = cursorPageSchema(journalEntryRowSchema);

const journalLineDetailSchema = z.object({
  id: z.number().int(),
  entryId: z.number().int(),
  accountId: z.number().int(),
  debit: z.string().nullable(),
  credit: z.string().nullable(),
  description: z.string().nullable(),
  lineOrder: z.number().int().nullable(),
  accountCode: z.string(),
  accountName: z.string(),
});

export const journalEntryDetailResponseSchema = journalEntryRowSchema.extend({
  createdByName: z.string().nullable(),
  createdByEmail: z.string().nullable(),
  lines: z.array(journalLineDetailSchema),
});

export const createJournalEntryResponseSchema = z.object({
  id: z.number().int(),
  entryNumber: z.string(),
});

export const postJournalEntryResponseSchema = z.object({
  id: z.number().int(),
  entryNumber: z.string(),
  status: z.string(),
});

export const reverseJournalEntryResponseSchema = z.object({
  id: z.number().int(),
  entryNumber: z.string(),
  created: z.boolean(),
});
