import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createBenefitPlanSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(["health", "life", "accident", "retirement", "wellness", "perk", "other"]),
  provider: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  coverage: z.record(z.string(), z.unknown()).optional(),
  premiumCents: z.number().int().min(0).optional(),
  employerContributionPct: z.number().int().min(0).max(100).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
}).strict();
export type CreateBenefitPlanInput = z.infer<typeof createBenefitPlanSchema>;

export const patchBenefitPlanSchema = createBenefitPlanSchema.partial().strict();
export type PatchBenefitPlanInput = z.infer<typeof patchBenefitPlanSchema>;

export const createEnrollmentWindowSchema = z.object({
  planId: z.number().int().optional(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  status: z.enum(["upcoming", "open", "closed"]).optional(),
}).strict();
export type CreateEnrollmentWindowInput = z.infer<typeof createEnrollmentWindowSchema>;

export const enrollSchema = z.object({
  planId: z.number().int().positive(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dependentsCovered: z.number().int().min(0).optional(),
}).strict();
export type EnrollInput = z.infer<typeof enrollSchema>;

export const waiveSchema = z.object({
  planId: z.number().int().positive(),
}).strict();
export type WaiveInput = z.infer<typeof waiveSchema>;

export const createDependentSchema = z.object({
  name: z.string().min(1).max(200),
  relationship: z.enum(["spouse", "child", "parent", "other"]),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  isCovered: z.boolean().optional(),
}).strict();
export type CreateDependentInput = z.infer<typeof createDependentSchema>;

export const patchDependentSchema = createDependentSchema.partial().strict();
export type PatchDependentInput = z.infer<typeof patchDependentSchema>;

export const submitClaimSchema = z.object({
  planId: z.number().int().positive(),
  claimNumber: z.string().min(1).max(100),
  amountCents: z.number().int().min(1),
  documents: z
    .array(z.object({ url: z.string().url(), name: z.string().min(1) }))
    .optional(),
}).strict();
export type SubmitClaimInput = z.infer<typeof submitClaimSchema>;

export const reviewClaimSchema = z.object({
  status: z.enum(["approved", "rejected", "in_review"]),
  rejectionReason: z.string().max(1000).optional(),
  payoutRoute: z.enum(["payroll_payable", "finance_payable", "already_paid"]).optional(),
}).strict();
export type ReviewClaimInput = z.infer<typeof reviewClaimSchema>;

export const setPayoutRouteSchema = z.object({
  payoutRoute: z.enum(["payroll_payable", "finance_payable", "already_paid"]),
}).strict();
export type SetPayoutRouteInput = z.infer<typeof setPayoutRouteSchema>;

export const createVisitLogSchema = z.object({
  travelRequestId: z.number().int().positive(),
  visitedAt: z.string().datetime(),
  location: z.string().min(1).max(500),
  lat: z.string().optional(),
  lng: z.string().optional(),
  note: z.string().max(2000).optional(),
}).strict();
export type CreateVisitLogInput = z.infer<typeof createVisitLogSchema>;

export const benefitPlansQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  category: z.enum(["health", "life", "accident", "retirement", "wellness", "perk", "other"]).optional(),
  limit: pageSizeField(20, 100),
}).strict();
export type BenefitPlansQuery = z.infer<typeof benefitPlansQuerySchema>;

export const availableBenefitPlansQuerySchema = benefitPlansQuerySchema.omit({ status: true }).strict();
export type AvailableBenefitPlansQuery = z.infer<typeof availableBenefitPlansQuerySchema>;

export const claimsQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["submitted", "in_review", "approved", "rejected", "paid"]).optional(),
  userId: z.string().trim().min(1).optional(),
}).strict();
export type ClaimsQuery = z.infer<typeof claimsQuerySchema>;
