import { z } from "zod";

const documentTypeNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name must be at most 100 characters")
  .refine((v) => /[a-zA-Z0-9]/.test(v), "Name must contain at least one letter or digit")
  .transform((v) => v.replace(/\s+/g, " ").trim());

const sortOrderSchema = z
  .number()
  .int("Sort order must be a whole number")
  .min(0, "Sort order must be 0 or greater")
  .optional();

export const listDocumentTypesSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const createDocumentTypeSchema = z.object({
  name: documentTypeNameSchema,
  description: z.string().max(500, "Description must be at most 500 characters").optional(),
  isMandatory: z.boolean().optional().default(true),
  applicableRoles: z.array(z.string()).optional().default([]),
  sortOrder: sortOrderSchema,
});

export const updateDocumentTypeSchema = z.object({
  name: documentTypeNameSchema.optional(),
  description: z.string().max(500).optional(),
  isMandatory: z.boolean().optional(),
  isActive: z.boolean().optional(),
  applicableRoles: z.array(z.string()).optional(),
  sortOrder: sortOrderSchema,
});

export type ListDocumentTypesInput = z.infer<typeof listDocumentTypesSchema>;
export type CreateDocumentTypeInput = z.infer<typeof createDocumentTypeSchema>;
export type UpdateDocumentTypeInput = z.infer<typeof updateDocumentTypeSchema>;
