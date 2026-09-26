import { z } from "zod";

export const reimbursementAmountSchema = z
  .number()
  .min(1, "Amount must be at least ₹1")
  .max(999999, "Amount cannot exceed ₹9,99,999")
  .refine(
    (v) => /^\d+(\.\d{1,2})?$/.test(String(v)),
    "Amount must have at most 2 decimal places",
  );
