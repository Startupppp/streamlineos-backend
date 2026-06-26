import { z } from "zod";

export const createDocumentTypeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters"),
  description: z.string().max(500, "Description must be at most 500 characters").optional(),
  isMandatory: z.boolean().optional().default(true),
  applicableRoles: z.array(z.string()).optional().default([]),
  sortOrder: z.number().int().optional().default(0),
});

export const updateDocumentTypeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100).optional(),
  description: z.string().max(500).optional(),
  isMandatory: z.boolean().optional(),
  isActive: z.boolean().optional(),
  applicableRoles: z.array(z.string()).optional(),
  sortOrder: z.number().int().optional(),
});

export type CreateDocumentTypeInput = z.infer<typeof createDocumentTypeSchema>;
export type UpdateDocumentTypeInput = z.infer<typeof updateDocumentTypeSchema>;
