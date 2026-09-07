import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, itemsPagedSchema, successSchema } from "../../../../common/openapi/response-envelopes";

const bonusRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  type: z.string(),
  amount: z.string(),
  amountCents: z.number().int().nullable().optional(),
  reason: z.string().nullable(),
  month: z.string().nullable(),
  taxable: z.boolean(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  createdAt: wireDate(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const bonusListResponseSchema = cursorPageSchema(bonusRowSchema);

export const bonusCreatedSchema = bonusRowSchema.omit({ userName: true, userEmail: true });

export const fnfRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  resignationId: z.number().int().nullable(),
  basicDues: z.string(),
  leaveEncashment: z.string(),
  bonusDue: z.string(),
  deductions: z.string(),
  loanRecovery: z.string(),
  netPayable: z.string(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  notes: z.string().nullable(),
  reimbursementsDue: z.string(),
  assetRecovery: z.string(),
  noticeRecovery: z.string(),
  otherDeductions: z.string(),
  statementPublishedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const fnfWithUserSchema = fnfRowSchema.extend({
  user: z.object({ name: z.string().nullable(), email: z.string() }).nullable().optional(),
});

export const fnfListResponseSchema = itemsPagedSchema(fnfWithUserSchema);

const incentiveItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  salesRepId: z.string(),
  clientAccountId: z.string().nullable(),
  investmentAmount: z.string().nullable(),
  incentiveRate: z.string().nullable(),
  calculatedAmount: z.string().nullable(),
  approvedAmount: z.string().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  salesRep: z.object({
    id: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
  }),
});

export const incentiveListResponseSchema = z.object({
  incentives: z.array(incentiveItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const incentiveConfigRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  incentiveRate: z.string(),
  effectiveFrom: wireDate(),
  createdAt: wireDate(),
  createdByName: z.string().nullable(),
});

export const incentiveConfigCreatedSchema = incentiveConfigRowSchema.omit({ createdByName: true });

export const incentiveStatsSchema = z.object({
  thisMonth: z.string(),
  totalRevenue: z.string(),
  avgPerConversion: z.string(),
  pending: z.number().int(),
  approved: z.number().int(),
});

const userMiniSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

export const loanRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  amount: z.string(),
  reason: z.string().nullable(),
  emiAmount: z.string().nullable(),
  totalEmis: z.number().int().nullable(),
  paidEmis: z.number().int(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  disbursedAt: nullableWireDate(),
  closedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: userMiniSchema.nullable().optional(),
});

export const loanListResponseSchema = itemsPagedSchema(loanRowSchema);

const reimbursementRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  category: z.string(),
  amount: z.string(),
  description: z.string().nullable(),
  receiptUrl: z.string().nullable(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  payrollMonth: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  paidAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: userMiniSchema.nullable().optional(),
});

export const reimbursementListResponseSchema = itemsPagedSchema(reimbursementRowSchema);

export const reimbursementCreatedSchema = reimbursementRowSchema.omit({ user: true });

export const salaryTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  basicSalary: z.string(),
  hraPercent: z.string(),
  specialAllowance: z.string().nullable(),
  medicalAllowance: z.string().nullable(),
  travelAllowance: z.string().nullable(),
  otherAllowances: z.string().nullable(),
  pfDeductionPercent: z.string().nullable(),
  professionalTax: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const salaryTemplateListSchema = cursorPageSchema(salaryTemplateRowSchema);

export { successSchema };
