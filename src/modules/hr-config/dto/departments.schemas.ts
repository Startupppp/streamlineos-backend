import { z } from "zod";

export const createDepartmentSchema = z.object({
  name: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(2, "Name must be at least 2 characters")
        .max(100, "Name must be at most 100 characters")
        .refine((v) => /[a-zA-Z]/.test(v), "Name must contain at least one letter")
        .refine(
          (v) => !/[^\p{L}\p{N}\s]{2,}/u.test(v),
          "Name cannot have consecutive special characters",
        ),
    ),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
