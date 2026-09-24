import { z } from "zod";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT"] as const;
/**
 * Every status the service can actually write, and nothing else.
 *
 * `PUBLISHED` and `CLOSED` were in this enum and no code path ever wrote
 * either, so `GET /requisitions?status=PUBLISHED` was a filter that could only
 * ever return nothing — a dead state a recruiter could select. `FILLED`
 * replaces the idea both were reaching for and IS written: an accepted offer
 * that consumes the job's last opening marks its requisition filled, so an
 * `APPROVED` requisition no longer sits behind a job nobody is hiring for.
 */
export const REQUISITION_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "FILLED",
] as const;

export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

/**
 * The status machine, mirroring how headcount already behaves. Submit, approve
 * and reject each overwrote the status from ANY prior value, so an approved
 * requisition could be re-submitted, a rejected one approved, and a filled one
 * walked back to draft.
 */
export const REQUISITION_TRANSITIONS: Record<RequisitionStatus, RequisitionStatus[]> = {
  DRAFT: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: ["FILLED"],
  /**
   * Both terminal. A rejected requisition is not re-opened — the requester
   * raises a new one, which is how `headcount_requests` already behaves, and it
   * keeps the rejection reason attached to the thing that was rejected.
   */
  REJECTED: [],
  FILLED: [],
};

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
