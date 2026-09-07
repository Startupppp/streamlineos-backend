import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const paymentTermSchema = z.object({
  key: z.string(),
  label: z.string(),
  days: z.number().int(),
  isDefault: z.boolean().optional(),
});

export const accountingSettingsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  baseCurrency: z.string(),
  fiscalYearStartMonth: z.number().int(),
  accountingBasis: z.string(),
  taxRegistration: z.unknown().nullable(),
  coaTemplate: z.string().nullable(),
  setupCompletedAt: nullableWireDate(),
  retainedEarningsAccountId: z.number().int().nullable(),
  paymentTerms: z.array(paymentTermSchema),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const setupStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
});

export const setupStatusResponseSchema = z.object({ steps: z.array(setupStepSchema) });

export const sequenceSchema = z.object({
  id: z.number().int().nullable(),
  orgId: z.string(),
  entityType: z.string(),
  prefix: z.string(),
  padding: z.number().int(),
  nextNumber: z.number().int(),
  createdAt: nullableWireDate(),
});

export const sequenceListResponseSchema = z.object({ items: z.array(sequenceSchema) });

const accountTreeNodeSchema: z.ZodType<{
  id: number;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string | null;
  isSystem: boolean;
  isActive: boolean;
  description: string | null;
  parentAccountId: number | null;
  hasActivity: boolean;
  children: unknown[];
}> = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  accountType: z.string(),
  normalBalance: z.string().nullable(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
  description: z.string().nullable(),
  parentAccountId: z.number().int().nullable(),
  hasActivity: z.boolean(),
  children: z.array(z.unknown()),
});

export const coaTreeResponseSchema = z.object({ items: z.array(accountTreeNodeSchema) });

const coaTemplateItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  country: z.string(),
  accountCount: z.number().int(),
});

export const coaTemplatesResponseSchema = z.object({ items: z.array(coaTemplateItemSchema) });

export const coaApplyTemplateResponseSchema = z.object({
  templateKey: z.string(),
  inserted: z.number().int(),
  skipped: z.number().int(),
});

export const coaAccountStatusResponseSchema = z.object({
  id: z.number().int(),
  isActive: z.boolean(),
});

export const coaDeleteAccountResponseSchema = z.object({
  id: z.number().int(),
  isActive: z.boolean(),
});

const dimensionSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  requiredForAccountTypes: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: wireDate(),
  valueCount: z.number().int(),
});

export const dimensionListResponseSchema = z.object({ items: z.array(dimensionSchema) });

const dimensionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  key: z.string(),
  requiredForAccountTypes: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: wireDate(),
});

export const dimensionCreatedResponseSchema = dimensionRowSchema;

const dimensionValueSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  dimensionId: z.number().int(),
  name: z.string(),
  code: z.string(),
  isActive: z.boolean(),
  createdAt: wireDate(),
});

export const dimensionValueListResponseSchema = z.object({ items: z.array(dimensionValueSchema) });

export const dimensionValueCreatedResponseSchema = dimensionValueSchema;

const openingBalanceLineSchema = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  accountCode: z.string(),
  accountName: z.string(),
  debit: z.string().nullable(),
  credit: z.string().nullable(),
});

const openingBalanceEntrySchema = z.object({
  id: z.number().int(),
  entryNumber: z.string(),
  entryDate: z.string(),
  status: z.string(),
  description: z.string().nullable(),
  createdAt: wireDate(),
  lines: z.array(openingBalanceLineSchema),
});

export const openingBalanceResponseSchema = z.discriminatedUnion("posted", [
  z.object({ posted: z.literal(false), entry: z.null() }),
  z.object({ posted: z.literal(true), entry: openingBalanceEntrySchema }),
]);

export const postOpeningBalancesResponseSchema = z.object({ reimported: z.boolean() });

const systemAccountRowSchema = z.object({
  purpose: z.string(),
  mapped: z.boolean(),
  accountId: z.number().int().nullable(),
  accountCode: z.string().nullable(),
  accountName: z.string().nullable(),
  accountType: z.string().nullable(),
  suggestedAccountId: z.number().int().nullable(),
  suggestedAccountCode: z.string().nullable(),
  suggestedAccountName: z.string().nullable(),
});

export const systemAccountListResponseSchema = z.array(systemAccountRowSchema);

export const upsertSystemAccountResponseSchema = z.object({
  purpose: z.string(),
  accountId: z.number().int(),
});
