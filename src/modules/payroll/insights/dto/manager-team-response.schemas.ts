import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const managerTeamMemberSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  pendingReimbursements: z.number().int(),
  pendingLoans: z.number().int(),
  latestPayslip: z
    .object({
      month: z.string(),
      net: z.string().nullable(),
      publicationId: z.number().int(),
    })
    .nullable(),
  taxDeclarationStatus: z.string().nullable(),
  actionCount: z.number().int(),
});

const managerPendingReimbursementSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userName: z.string().nullable(),
  category: z.string(),
  amount: z.string(),
  description: z.string().nullable(),
  createdAt: wireDate(),
});

const managerPendingLoanSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  userName: z.string().nullable(),
  amount: z.string(),
  reason: z.string().nullable(),
  totalEmis: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const managerInboxResultSchema = z.object({
  mode: z.literal("manager_self_service"),
  honestyNote: z.string(),
  reportCount: z.number().int(),
  canApproveReimbursements: z.boolean(),
  canApproveLoans: z.boolean(),
  members: z.array(managerTeamMemberSchema),
  pendingReimbursements: z.array(managerPendingReimbursementSchema),
  pendingLoans: z.array(managerPendingLoanSchema),
  totals: z.object({
    pendingReimbursements: z.number().int(),
    pendingLoans: z.number().int(),
    membersNeedingAction: z.number().int(),
  }),
});

const teamRewardsMemberRowSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  annualCtc: z.string().nullable(),
  activeBenefitPlans: z.number().int(),
  estimatedEmployerBenefitsAnnual: z.string().nullable(),
  equityUnits: z.number().int(),
});

export const payCompressionResultSchema = z.object({
  mode: z.literal("cash_ctc_only"),
  honestyNote: z.string(),
  sampleSize: z.number().int(),
  stats: z.object({
    min: z.string(),
    max: z.string(),
    mean: z.string(),
    median: z.string(),
    p25: z.string(),
    p75: z.string(),
    compressionRatio: z.string().nullable(),
  }),
  outliers: z.array(
    z.object({
      userId: z.string(),
      label: z.string().nullable(),
      annualCtc: z.string(),
      side: z.enum(["below", "above"]),
    }),
  ),
  missingCtcCount: z.number().int(),
});

export const teamRewardsResultSchema = z.object({
  mode: z.literal("manager_team_rewards"),
  honestyNote: z.string(),
  reportCount: z.number().int(),
  members: z.array(teamRewardsMemberRowSchema),
  payCompression: payCompressionResultSchema,
});

export const orgPayCompressionSchema = payCompressionResultSchema.extend({
  scope: z.literal("organization"),
});
