import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export { successSchema };

export const departmentItemSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const documentTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  type: z.string(),
  htmlContent: z.string(),
  variables: z.array(z.string()),
  version: z.number().int(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const documentTemplatePreviewSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  type: z.string(),
  htmlContent: z.string(),
  variables: z.array(z.string()),
  version: z.number().int(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  previewVariables: z.record(z.string(), z.string()),
});

const documentTypeRoleSchema = z.object({ roleSlug: z.string() });

export const documentTypeRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  countryCode: z.string().nullable(),
  isMandatory: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  roles: z.array(documentTypeRoleSchema),
});

export const documentTypeListPageSchema = z.object({
  data: z.array(documentTypeRowSchema),
  pagination: z.object({
    limit: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export const emailTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  category: z.string(),
  variables: z.array(z.string()).nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const emailTemplateAiSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export const handbookRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  version: z.string(),
  title: z.string(),
  documentId: z.number().int().nullable(),
  documentUrl: z.string().nullable(),
  changelog: z.string().nullable(),
  publishedAt: nullableWireDate(),
  publishedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const holidayRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  date: z.string(),
  message: z.string().nullable(),
  isPublic: z.boolean(),
  notificationSent: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const interviewQuestionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  question: z.string(),
  category: z.string(),
  role: z.string().nullable(),
  difficulty: z.string(),
  tags: z.array(z.string()),
  sampleAnswer: z.string().nullable(),
  keywords: z.array(z.string()),
  isActive: z.boolean(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const leaveBlackoutRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  reason: z.string(),
  appliesTo: z.string(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const notificationPreferencesSchema = z.object({
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  inAppEnabled: z.boolean(),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  categories: z.record(z.string(), z.unknown()),
});

export const salaryProfileRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  workerType: z.string(),
  payFrequency: z.string(),
  currency: z.string(),
  payoutCurrency: z.string().nullable(),
  fxSource: z.string().nullable(),
  taxRegime: z.string().nullable(),
  costCenter: z.string().nullable(),
  annualCtc: z.string(),
  basicSalary: z.string().nullable(),
  hraPercentage: z.string().nullable(),
  allowances: z.string(),
  deductions: z.string(),
  status: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  policyVersionId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});
