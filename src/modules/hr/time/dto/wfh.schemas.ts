import { z } from "zod";

export const createWfhSchema = z.object({
  date: z
    .string()
    .min(1, "Date is required")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .refine((v) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const selected = new Date(`${v}T00:00:00`);
      return selected >= today;
    }, "WFH date cannot be in the past"),
  reason: z.string().max(1000, "Reason must be 1000 characters or fewer").optional(),
  approverId: z.string().min(1, "Approver is required"),
}).strict();

export const updateWfhSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
}).strict();

export type CreateWfhInput = z.infer<typeof createWfhSchema>;
export type UpdateWfhInput = z.infer<typeof updateWfhSchema>;
