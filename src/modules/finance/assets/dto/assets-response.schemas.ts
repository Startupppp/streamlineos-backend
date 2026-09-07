import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const assetCategorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  assetAccountId: z.number().int(),
  depreciationExpenseAccountId: z.number().int(),
  accumulatedDepreciationAccountId: z.number().int(),
  defaultMethod: z.enum(["STRAIGHT_LINE", "DECLINING_BALANCE", "UNITS_OF_PRODUCTION"]),
  defaultUsefulLifeMonths: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const assetCategoryListResponseSchema = cursorPageSchema(assetCategorySchema);

export const assetSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  assetNumber: z.string(),
  name: z.string(),
  categoryId: z.number().int(),
  acquisitionDate: z.string(),
  acquisitionCost: z.string(),
  salvageValue: z.string(),
  usefulLifeMonths: z.number().int(),
  depreciationMethod: z.enum(["STRAIGHT_LINE", "DECLINING_BALANCE", "UNITS_OF_PRODUCTION"]),
  vendorId: z.number().int().nullable(),
  billId: z.number().int().nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"]),
  accumulatedDepreciation: z.string(),
  disposedAt: nullableWireDate(),
  disposalAmount: z.string().nullable(),
  disposalJournalEntryId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const assetListItemSchema = z.object({
  asset: assetSchema,
  categoryName: z.string().nullable(),
});

export const assetListResponseSchema = cursorPageSchema(assetListItemSchema);

const depreciationScheduleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  assetId: z.number().int(),
  periodKey: z.string(),
  amount: z.string(),
  runId: z.number().int().nullable(),
  journalEntryId: z.number().int().nullable(),
  status: z.enum(["SCHEDULED", "POSTED"]),
});

const assetCategoryDetailSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  assetAccountId: z.number().int(),
  depreciationExpenseAccountId: z.number().int(),
  accumulatedDepreciationAccountId: z.number().int(),
  defaultMethod: z.enum(["STRAIGHT_LINE", "DECLINING_BALANCE", "UNITS_OF_PRODUCTION"]),
  defaultUsefulLifeMonths: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
}).nullable();

export const assetDetailResponseSchema = z.object({
  asset: assetSchema,
  category: assetCategoryDetailSchema,
  schedules: z.array(depreciationScheduleSchema),
});

export const assetDisposeResponseSchema = z.object({
  assetId: z.number().int(),
  journalEntryId: z.number().int(),
  entryNumber: z.string(),
});

const depreciationRunSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  periodKey: z.string(),
  status: z.enum(["DRAFT", "POSTED"]),
  totalAmount: z.string(),
  journalEntryId: z.number().int().nullable(),
  createdBy: z.string(),
  postedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const depreciationRunListResponseSchema = cursorPageSchema(depreciationRunSchema);

export const depreciationRunCreateResponseSchema = depreciationRunSchema;

export const depreciationRunReverseResponseSchema = z.object({
  runId: z.number().int(),
  reversalEntryId: z.number().int(),
  reversalEntryNumber: z.string(),
});

