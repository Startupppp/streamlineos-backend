import { z } from "zod";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT"] as const;
const REQUISITION_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "PUBLISHED",
  "CLOSED",
  "REJECTED",
] as const;

export const requisitionListSchema = z.object({
  status: z.enum(REQUISITION_STATUSES).optional(),
}).strict();
export type RequisitionListInput = z.infer<typeof requisitionListSchema>;

export const createRequisitionSchema = z.object({
  title: z.string().min(2).max(200),
  department: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
  headcount: z.number().int().min(1).max(999).default(1),
  headcountId: z.number().int().positive().optional(),
  budgetMin: z.number().min(0).optional(),
  budgetMax: z.number().min(0).optional(),
  hiringManagerId: z.string().optional(),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  type: z.enum(EMPLOYMENT_TYPES).default("FULL_TIME"),
  justification: z.string().max(5000).optional(),
  targetDate: z.string().optional(),
}).strict();
export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;

export const updateRequisitionSchema = createRequisitionSchema.partial().strict();
export type UpdateRequisitionInput = z.infer<typeof updateRequisitionSchema>;

export const rejectRequisitionSchema = z.object({
  reason: z.string().min(1, "Rejection reason is required").max(2000),
}).strict();
export type RejectRequisitionInput = z.infer<typeof rejectRequisitionSchema>;
