import { z } from "zod";
import { managedProductStatusEnum } from "../../../../db/schema";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const MANAGED_PRODUCTS_BULK_MAX = 100;

export const listManagedProductsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  status: z.enum(managedProductStatusEnum.enumValues).optional(),
  search: z.string().optional(),
  ownerId: z.string().optional(),
  sort: z.enum(["name", "updated", "status"]).optional(),
}).strict();

export const createManagedProductSchema = z.object({
  name: z.string().min(1).max(255),
  key: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/, "Key must be uppercase letters, digits, hyphens, or underscores"),
  description: z.string().optional(),
  ownerId: z.string().min(1).optional(),
}).strict();

export const updateManagedProductSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(managedProductStatusEnum.enumValues).optional(),
}).strict();

export const bulkManagedProductsSchema = z
  .object({
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(MANAGED_PRODUCTS_BULK_MAX),
    action: z.enum(["update_status"]),
    status: z.enum(managedProductStatusEnum.enumValues).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.action === "update_status" && !val.status) {
      ctx.addIssue({
        code: "custom",
        message: "status is required for update_status action",
        path: ["status"],
      });
    }
  });

export const managedProductInsightsQuerySchema = z
  .object({
    range: z.enum(["7d", "30d", "90d"]).optional(),
  })
  .strict();

export type ListManagedProductsQuery = z.infer<typeof listManagedProductsQuerySchema>;
export type CreateManagedProductInput = z.infer<typeof createManagedProductSchema>;
export type UpdateManagedProductInput = z.infer<typeof updateManagedProductSchema>;
export type BulkManagedProductsInput = z.infer<typeof bulkManagedProductsSchema>;
export type ProductInsightsQuery = z.infer<typeof managedProductInsightsQuerySchema>;
