import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listCategoriesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const createCategorySchema = z.object({
  name: z.string().min(1).max(200),
  assetAccountId: z.number().int().positive(),
  depreciationExpenseAccountId: z.number().int().positive(),
  accumulatedDepreciationAccountId: z.number().int().positive(),
  defaultMethod: z.enum(["STRAIGHT_LINE", "DECLINING_BALANCE", "UNITS_OF_PRODUCTION"]).default("STRAIGHT_LINE"),
  defaultUsefulLifeMonths: z.number().int().positive().optional(),
}).strict();

export const updateCategorySchema = createCategorySchema.partial().strict();

export const listAssetsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["DRAFT", "ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"]).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
}).strict();

export const createAssetSchema = z.object({
  name: z.string().min(1).max(500),
  categoryId: z.number().int().positive(),
  acquisitionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  acquisitionCost: z.string().regex(/^\d+(\.\d{1,4})?$/),
  salvageValue: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  usefulLifeMonths: z.number().int().positive(),
  depreciationMethod: z.enum(["STRAIGHT_LINE", "DECLINING_BALANCE", "UNITS_OF_PRODUCTION"]).default("STRAIGHT_LINE"),
  vendorId: z.number().int().positive().optional(),
  billId: z.number().int().positive().optional(),
}).strict();

export const updateAssetSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  categoryId: z.number().int().positive().optional(),
  salvageValue: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  usefulLifeMonths: z.number().int().positive().optional(),
}).strict();

export const disposeAssetSchema = z.object({
  disposalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/),
}).strict();

export const listRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const createRunSchema = z.object({
  periodKey: z.string().regex(/^\d{4}-\d{2}$/, "Must be YYYY-MM format"),
}).strict();

export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type DisposeAssetInput = z.infer<typeof disposeAssetSchema>;
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
