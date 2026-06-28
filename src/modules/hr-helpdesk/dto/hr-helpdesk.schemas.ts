import { z } from "zod";

const ticketStatusSchema = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
const ticketPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const listSchema = z.object({
  userId: z.string().min(1).optional(),
  status: ticketStatusSchema.optional(),
});

export const createSchema = z.object({
  title: z
    .string()
    .min(5, "Ticket title must be at least 5 characters")
    .max(150, "Ticket title must be at most 150 characters")
    .refine((v) => /[a-zA-Z0-9]/.test(v.trim()), "Ticket title must contain at least one letter or digit")
    .refine((v) => !/\s{2,}/.test(v), "Ticket title cannot have multiple consecutive spaces"),
  description: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(10, "Description must be at least 10 characters").max(2000, "Description must be at most 2000 characters").optional(),
  ),
  category: z.string().min(1, "Category is required"),
  priority: ticketPrioritySchema.optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
