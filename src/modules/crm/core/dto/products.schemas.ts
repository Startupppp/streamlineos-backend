import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().min(1, "Name required").max(200),
  description: z.string().optional(),
  sku: z.string().optional(),
  category: z.string().optional(),
  unitPrice: z.number().positive("Unit price must be positive"),
  currency: z.string().default("INR"),
  taxRate: z.number().min(0).max(100).default(0),
}).strict();

export const updateProductSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  sku: z.string().optional(),
  category: z.string().optional(),
  unitPrice: z.number().positive().optional(),
  currency: z.string().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
}).strict();

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
