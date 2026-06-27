import { z } from "zod";

const optionalTrimmed = z
  .string()
  .transform((v) => v.trim())
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const hasLetter = (v: string) => /[a-zA-Z]/.test(v);
const noConsecutiveSpaces = (v: string) => !/\s{2}/.test(v);

export const createBranchSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Branch name is required")
    .max(100, "Branch name must be at most 100 characters")
    .refine(hasLetter, "Branch name must contain at least one letter")
    .refine(noConsecutiveSpaces, "Branch name must not contain consecutive spaces"),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,20}$/, "Branch code must be 2–20 alphanumeric characters"),
  city: optionalTrimmed
    .refine((v) => !v || hasLetter(v), "City must contain at least one letter")
    .refine((v) => !v || v.length <= 100, "City must be at most 100 characters"),
  state: optionalTrimmed
    .refine((v) => !v || hasLetter(v), "State must contain at least one letter")
    .refine((v) => !v || v.length <= 100, "State must be at most 100 characters"),
  country: optionalTrimmed,
  pincode: optionalTrimmed.refine((v) => !v || /^[A-Za-z0-9]{4,10}$/.test(v), {
    message: "Pin code must be 4–10 alphanumeric characters",
  }),
  address: optionalTrimmed.refine((v) => !v || v.length <= 500, {
    message: "Address must be at most 500 characters",
  }),
  phone: optionalTrimmed.refine(
    (v) => {
      if (!v) return true;
      if (/[a-zA-Z]/.test(v)) return false;
      const digits = v.replace(/[+\s-]/g, "");
      return digits.length >= 7 && digits.length <= 15;
    },
    { message: "Phone number must have 7–15 digits and no letters" },
  ),
  email: optionalTrimmed.refine((v) => !v || z.string().email().safeParse(v).success, {
    message: "Enter a valid email address",
  }),
  branchManagerId: z.string().optional(),
  branchHrId: z.string().optional(),
});

export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Branch name is required")
    .max(100, "Branch name must be at most 100 characters")
    .refine(hasLetter, "Branch name must contain at least one letter")
    .refine(noConsecutiveSpaces, "Branch name must not contain consecutive spaces")
    .optional(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,20}$/, "Branch code must be 2–20 alphanumeric characters")
    .optional(),
  city: optionalTrimmed
    .refine((v) => !v || hasLetter(v), "City must contain at least one letter")
    .refine((v) => !v || v.length <= 100, "City must be at most 100 characters"),
  state: optionalTrimmed
    .refine((v) => !v || hasLetter(v), "State must contain at least one letter")
    .refine((v) => !v || v.length <= 100, "State must be at most 100 characters"),
  country: optionalTrimmed,
  pincode: optionalTrimmed.refine((v) => !v || /^[A-Za-z0-9]{4,10}$/.test(v), {
    message: "Pin code must be 4–10 alphanumeric characters",
  }),
  address: optionalTrimmed.refine((v) => !v || v.length <= 500, {
    message: "Address must be at most 500 characters",
  }),
  phone: optionalTrimmed.refine(
    (v) => {
      if (!v) return true;
      if (/[a-zA-Z]/.test(v)) return false;
      const digits = v.replace(/[+\s-]/g, "");
      return digits.length >= 7 && digits.length <= 15;
    },
    { message: "Phone number must have 7–15 digits and no letters" },
  ),
  email: optionalTrimmed.refine((v) => !v || z.string().email().safeParse(v).success, {
    message: "Enter a valid email address",
  }),
  branchManagerId: z.string().optional(),
  branchHrId: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
