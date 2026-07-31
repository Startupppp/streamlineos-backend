import { z } from "zod";

const fieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "email", "phone", "textarea", "select"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const webFormCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  fields: z.array(fieldSchema).default([]),
  submitMessage: z.string().optional(),
  redirectUrl: z.string().url().optional().or(z.literal("")),
  isActive: z.boolean().optional().default(true),
});

export const webFormUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  fields: z.array(fieldSchema).optional(),
  submitMessage: z.string().optional(),
  redirectUrl: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export type WebFormCreateInput = z.infer<typeof webFormCreateSchema>;
export type WebFormUpdateInput = z.infer<typeof webFormUpdateSchema>;
