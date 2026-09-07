import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const benefitPlanSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  category: z.enum(["health", "life", "accident", "retirement", "wellness", "perk", "other"]),
  provider: z.string().nullable(),
  description: z.string().nullable(),
  coverage: z.record(z.string(), z.unknown()).nullable(),
  premiumCents: z.number().int().nullable(),
  employerContributionPct: z.number().int(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  status: z.enum(["draft", "active", "archived"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listPlansResponseSchema = cursorPageSchema(benefitPlanSchema);
export const getPlanResponseSchema = benefitPlanSchema;
export const createPlanResponseSchema = benefitPlanSchema;
export const updatePlanResponseSchema = benefitPlanSchema;

const enrollmentWindowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  planId: z.number().int().nullable(),
  opensAt: wireDate(),
  closesAt: wireDate(),
  status: z.enum(["upcoming", "open", "closed"]),
  createdAt: wireDate(),
});

export const listWindowsResponseSchema = z.array(enrollmentWindowSchema);
export const createWindowResponseSchema = enrollmentWindowSchema;
export const updateWindowResponseSchema = enrollmentWindowSchema;

const enrollmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  planId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.enum(["pending", "active", "waived", "terminated"]),
  enrolledAt: wireDate(),
  effectiveFrom: z.string().nullable(),
  dependentsCovered: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const checkEligibilityResponseSchema = z.object({
  eligible: z.boolean(),
  planId: z.number().int().optional(),
  planName: z.string().optional(),
  policy: z.record(z.string(), z.unknown()).nullable().optional(),
  reason: z.string().optional(),
});

export const enrollResponseSchema = enrollmentSchema;
export const waiveResponseSchema = enrollmentSchema;

const dependentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  name: z.string(),
  relationship: z.enum(["spouse", "child", "parent", "other"]),
  dateOfBirth: z.string().nullable(),
  isCovered: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listDependentsResponseSchema = z.array(dependentSchema);
export const addDependentResponseSchema = dependentSchema;
export const updateDependentResponseSchema = dependentSchema;

const claimSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  planId: z.number().int(),
  claimNumber: z.string(),
  amountCents: z.number().int(),
  status: z.enum(["submitted", "in_review", "approved", "rejected", "paid"]),
  documents: z.array(z.object({ url: z.string(), name: z.string() })).nullable(),
  submittedAt: wireDate(),
  decidedAt: nullableWireDate(),
  decidedBy: z.string().nullable(),
  decidedByMembershipId: z.number().int().nullable(),
  rejectionReason: z.string().nullable(),
  payoutRoute: z.enum(["payroll_payable", "finance_payable", "already_paid"]).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const userMinSchema = z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() });

export const listClaimsResponseSchema = z.object({
  data: z.array(claimSchema.extend({ user: userMinSchema, plan: benefitPlanSchema.nullable() })),
  pagination: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const submitClaimResponseSchema = claimSchema;
export const reviewClaimResponseSchema = claimSchema;

const travelVisitSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  travelRequestId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  visitedAt: wireDate(),
  location: z.string(),
  lat: z.string().nullable(),
  lng: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: wireDate(),
});

export const listTravelVisitsResponseSchema = z.array(travelVisitSchema);
export const addTravelVisitResponseSchema = travelVisitSchema;

export const deletePlanResponseSchema = z.object({ ok: z.literal(true) });
export const getMyBenefitsResponseSchema = z.object({
  enrollments: z.array(enrollmentSchema.extend({ plan: benefitPlanSchema })),
  dependents: z.array(z.object({
    id: z.number().int(),
    orgId: z.string(),
    userId: z.string(),
    name: z.string(),
    relationship: z.enum(["spouse", "child", "parent", "other"]),
    dateOfBirth: z.string().nullable(),
    isCovered: z.boolean(),
    createdAt: wireDate(),
  })),
});
export const deleteDependentResponseSchema = z.object({ ok: z.literal(true) });
export const setPayoutRouteResponseSchema = claimSchema;
