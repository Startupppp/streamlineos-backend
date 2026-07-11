import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createUnionMembershipSchema = z.object({
  userId: z.string().min(1),
  unionName: z.string().min(1).max(300),
  memberSince: z.string().min(1),
  status: z.enum(["active", "inactive"]),
});

export const updateUnionMembershipSchema = createUnionMembershipSchema.partial();

export const listUnionMembershipsSchema = paginationSchema.extend({
  unionName: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  userId: z.string().optional(),
});

export const createCollectiveAgreementSchema = z.object({
  unionName: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  effectiveFrom: z.string().min(1),
  expiresAt: z.string().optional(),
  documentUrl: z.string().url().optional(),
  status: z.enum(["active", "expired", "negotiating"]),
});

export const updateCollectiveAgreementSchema = createCollectiveAgreementSchema.partial();

export const listAgreementsSchema = paginationSchema.extend({
  status: z.enum(["active", "expired", "negotiating"]).optional(),
  unionName: z.string().optional(),
});

export const expiringAgreementsSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const createLaborCaseSchema = z.object({
  unionName: z.string().min(1).max(300),
  subject: z.string().min(1).max(500),
  description: z.string().min(1).max(10000),
  status: z.enum(["open", "in_review", "resolved"]).optional(),
});

export const updateLaborCaseSchema = createLaborCaseSchema.partial();

export const listLaborCasesSchema = paginationSchema.extend({
  status: z.enum(["open", "in_review", "resolved"]).optional(),
  unionName: z.string().optional(),
});

export type CreateUnionMembershipInput = z.infer<typeof createUnionMembershipSchema>;
export type UpdateUnionMembershipInput = z.infer<typeof updateUnionMembershipSchema>;
export type ListUnionMembershipsInput = z.infer<typeof listUnionMembershipsSchema>;
export type CreateCollectiveAgreementInput = z.infer<typeof createCollectiveAgreementSchema>;
export type UpdateCollectiveAgreementInput = z.infer<typeof updateCollectiveAgreementSchema>;
export type ListAgreementsInput = z.infer<typeof listAgreementsSchema>;
export type ExpiringAgreementsInput = z.infer<typeof expiringAgreementsSchema>;
export type CreateLaborCaseInput = z.infer<typeof createLaborCaseSchema>;
export type UpdateLaborCaseInput = z.infer<typeof updateLaborCaseSchema>;
export type ListLaborCasesInput = z.infer<typeof listLaborCasesSchema>;
