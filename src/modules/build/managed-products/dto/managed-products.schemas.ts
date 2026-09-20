import { z } from "zod";
import { managedProductStatusEnum } from "../../../../db/schema";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listManagedProductsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  status: z.enum(managedProductStatusEnum.enumValues).optional(),
  pmWorkspaceId: z.string().optional(),
  search: z.string().optional(),
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
  pmWorkspaceId: z.string().optional(),
}).strict();

export const updateManagedProductSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(managedProductStatusEnum.enumValues).optional(),
}).strict();

export type ListManagedProductsQuery = z.infer<typeof listManagedProductsQuerySchema>;
export type CreateManagedProductInput = z.infer<typeof createManagedProductSchema>;
export type UpdateManagedProductInput = z.infer<typeof updateManagedProductSchema>;
