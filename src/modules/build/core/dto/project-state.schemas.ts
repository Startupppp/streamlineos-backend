import { z } from "zod";

const columnNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(50, "Name must be 50 characters or fewer")
  .refine((v) => /[a-zA-Z0-9]/.test(v), {
    message: "Name must contain at least one letter or number",
  });

export const projectStatusTypeSchema = z.enum([
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);

export const createStateSchema = z.object({
  name: columnNameSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  order: z.number().int().min(0).optional(),
  type: projectStatusTypeSchema.optional(),
}).strict();

export const updateCustomStateSchema = z.object({
  name: columnNameSchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  order: z.number().int().min(0).optional(),
  type: projectStatusTypeSchema.optional(),
}).strict();

export const createLabelSchema = z.object({
  name: z.string().min(1, "Label name is required"),
  color: z.string().optional(),
}).strict();

export const updateLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
}).strict();

export const bulkReorderStatesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            stateId: z.number().int().positive(),
            order: z.number().int().min(0),
            expectedOrder: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;
export type UpdateCustomStateInput = z.infer<typeof updateCustomStateSchema>;
export type CreateStateInput = z.infer<typeof createStateSchema>;
export type CreateLabelInput = z.infer<typeof createLabelSchema>;
export type BulkReorderStatesInput = z.infer<typeof bulkReorderStatesSchema>;
