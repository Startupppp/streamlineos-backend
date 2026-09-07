import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const userRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

const userRefWithEmailSchema = userRefSchema.extend({ email: z.string().nullable() });

const clientAccountRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  branchId: z.string().nullable(),
  leadId: z.number().int(),
  salesRepId: z.string(),
  salesRepMembershipId: z.number().int().nullable(),
  assignedCrmId: z.string().nullable(),
  assignedCrmMembershipId: z.number().int().nullable(),
  clientName: z.string(),
  clientEmail: z.string().nullable(),
  clientPhone: z.string().nullable(),
  clientWhatsapp: z.string().nullable(),
  status: z.string(),
  investmentAmount: z.string().nullable(),
  planName: z.string().nullable(),
  investmentDate: nullableWireDate(),
  transactionRef: z.string().nullable(),
  conversionNotes: z.string().nullable(),
  estimatedInvestment: z.string().nullable(),
  convertedAt: wireDate(),
  investedAt: nullableWireDate(),
  renewalStage: z.string(),
  renewalDate: z.string().nullable(),
  renewalNotes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const clientAccountListItemSchema = clientAccountRowSchema.extend({
  salesRep: userRefSchema,
  assignedCrm: userRefSchema.nullable(),
});

export const clientAccountsListSchema = z.object({
  accounts: z.array(clientAccountListItemSchema),
  totalCount: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});

const activityRowSchema = z.object({
  id: z.number().int(),
  clientAccountId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  activityType: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  user: userRefSchema.optional(),
});

export const clientAccountDetailSchema = clientAccountRowSchema.extend({
  salesRep: userRefWithEmailSchema,
  assignedCrm: userRefWithEmailSchema.nullable(),
  lead: z
    .object({
      id: z.number().int(),
      name: z.string().nullable(),
      source: z.string().nullable(),
      priority: z.string().nullable(),
    })
    .nullable(),
  activities: z.array(activityRowSchema),
});

export const clientListSchema = z.array(
  z.object({ id: z.number().int(), name: z.string().nullable() }),
);

const healthItemSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  company: z.string().nullable(),
  healthScore: z.number().int().nullable(),
  healthStatus: z.string().nullable(),
  churnRiskScore: z.number().int().nullable(),
  churnRiskReasoning: z.string().nullable(),
  lastHealthCheck: z.string().nullable(),
  investmentValue: z.string().nullable(),
  status: z.string().nullable(),
});

export const clientHealthSchema = z.object({
  items: z.array(healthItemSchema),
  summary: z.object({
    healthy: z.number().int(),
    at_risk: z.number().int(),
    critical: z.number().int(),
  }),
});

export const churnAlertsSchema = z.object({
  alerts: z.array(
    healthItemSchema.extend({
      accountManagerId: z.string().nullable(),
      accountManagerName: z.string().nullable(),
    }),
  ),
  summary: z.object({
    critical: z.number().int(),
    atRisk: z.number().int(),
    total: z.number().int(),
  }),
});

export const crmAssignmentStatsSchema = z.object({
  members: z.array(
    z.object({
      userId: z.string(),
      name: z.string().nullable(),
      image: z.string().nullable(),
      totalCount: z.number().int(),
    }),
  ),
  unassignedCount: z.number().int(),
});

export const renewalListSchema = z.array(
  clientAccountRowSchema.extend({ salesRep: userRefSchema }),
);

export const renewalUpdateSchema = clientAccountRowSchema;

const opportunityRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int(),
  title: z.string(),
  type: z.string(),
  stage: z.string(),
  value: z.string().nullable(),
  notes: z.string().nullable(),
  expectedCloseDate: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const opportunityListSchema = z.array(opportunityRowSchema);
export const opportunityRowExportSchema = opportunityRowSchema;

const onboardingItemRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int(),
  templateId: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  assignedTo: z.string().nullable(),
  assignedToMembershipId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  completedAt: nullableWireDate(),
  completedBy: z.string().nullable(),
  completedByMembershipId: z.number().int().nullable(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const onboardingItemListSchema = z.array(onboardingItemRowSchema);
export const onboardingItemRowExportSchema = onboardingItemRowSchema;

const onboardingTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const onboardingTemplateListSchema = z.array(onboardingTemplateRowSchema);
export const onboardingTemplateRowExportSchema = onboardingTemplateRowSchema;

export const clientStatusUpdateSchema = clientAccountRowSchema;

const timelineEventSchema = z.object({
  type: z.string(),
  title: z.string(),
  description: z.string(),
  date: z.string(),
});

export const clientTimelineSchema = z.object({
  events: z.array(timelineEventSchema),
  total: z.number().int(),
});

export const clientActivitiesSchema = z.array(activityRowSchema);
export const activityCreateSchema = activityRowSchema;

export const exportCsvSchema = z.string();
