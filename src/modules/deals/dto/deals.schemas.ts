import { z } from "zod";

export const dealStageSchema = z.string().min(1);

export const listDealsSchema = z.object({
  stage: dealStageSchema.optional(),
  assignedToId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

export const createDealSchema = z.object({
  name: z.string().min(1),
  value: z.coerce.number().min(0).optional(),
  stage: dealStageSchema.optional(),
  probability: z.number().min(0).max(100).optional(),
  contactPerson: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal("")),
  contactPhone: z.string().optional(),
  assignedToId: z.string().optional(),
  expectedCloseDate: z.string().optional(),
  notes: z.string().optional(),
  leadId: z.number().optional(),
  clientId: z.number().optional(),
});

export const updateDealSchema = z.object({
  name: z.string().min(1).optional(),
  value: z.coerce.number().min(0).optional(),
  stage: dealStageSchema.optional(),
  probability: z.number().min(0).max(100).optional(),
  contactPerson: z.string().optional(),
  contactEmail: z.string().optional(),
  contactPhone: z.string().optional(),
  assignedToId: z.string().optional(),
  expectedCloseDate: z.string().nullable().optional(),
  actualCloseDate: z.string().nullable().optional(),
  lostReason: z.string().optional(),
  notes: z.string().optional(),
  version: z.string().datetime().optional(),
});

export const resolveApprovalSchema = z.object({
  approvalId: z.number().int().positive(),
  action: z.enum(["approve", "reject"]),
  rejectionReason: z.string().optional(),
});

export const requestApprovalSchema = z.object({
  dealId: z.number().int().positive(),
  requestedStage: z.string().min(1),
});

export const submitApprovalSchema = z.union([resolveApprovalSchema, requestApprovalSchema]);

export const logActivitySchema = z.object({
  type: z.enum(["call", "email", "meeting", "note", "document"]),
  subject: z.string().optional(),
  notes: z.string().optional(),
  duration: z.number().int().min(0).optional(),
  previousValue: z.string().optional(),
  newValue: z.string().optional(),
});

export const patchCustomDataSchema = z.object({
  customData: z.record(z.string(), z.unknown()),
});

export const createApprovalRuleSchema = z.object({
  minValue: z.string().min(1, "Minimum value is required"),
  approverType: z.enum(["role", "user", "manager"]).default("role"),
  approverRole: z.string().optional(),
  approverUserId: z.string().optional(),
});

export const approvalsListSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const createMeetingSchema = z.object({
  title: z.string().min(1).max(200),
  scheduledAt: z.string().min(1),
  durationMinutes: z.number().int().min(5).max(480).optional().default(30),
  attendees: z.array(z.string()).optional().default([]),
  agenda: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  actionItems: z.string().max(2000).optional(),
  recordingLink: z.string().url().optional().or(z.literal("")),
  status: z.enum(["scheduled", "completed", "cancelled"]).optional().default("scheduled"),
});

export const updateMeetingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  scheduledAt: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  attendees: z.array(z.string()).optional(),
  agenda: z.string().max(2000).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  actionItems: z.string().max(2000).optional().nullable(),
  recordingLink: z.string().url().optional().nullable().or(z.literal("")),
  status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
});

export const createCompetitorSchema = z.object({
  competitorKey: z.string().min(1),
  status: z.enum(["active", "won_against", "lost_to"]).default("active"),
  notes: z.string().max(1000).optional(),
});

export const updateCompetitorSchema = createCompetitorSchema.omit({ competitorKey: true }).partial();

export const patchNextStepSchema = z.object({
  nextStep: z.string().max(500).nullable(),
});

export const createForecastSnapshotSchema = z.object({
  period: z.string().min(1),
});

export const compareForecastSnapshotsSchema = z.object({
  period: z.string().min(1),
});

export const forecastSnapshotsQuerySchema = z.object({
  period: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
  offset: z.coerce.number().min(0).optional(),
});

export const createStakeholderSchema = z.object({
  contactId: z.number().int().positive(),
  roleKey: z.string().max(100).nullable().optional(),
  influence: z.enum(["low", "medium", "high", "blocker"]).nullable().optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateStakeholderSchema = z.object({
  roleKey: z.string().max(100).nullable().optional(),
  influence: z.enum(["low", "medium", "high", "blocker"]).nullable().optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const overrideForecastSnapshotSchema = z.object({
  overrideAmount: z.number().min(0).optional(),
  overrideNote: z.string().max(1000).optional(),
});

export type ListDealsInput = z.infer<typeof listDealsSchema>;
export type CreateDealInput = z.infer<typeof createDealSchema>;
export type UpdateDealInput = z.infer<typeof updateDealSchema>;
export type ResolveApprovalInput = z.infer<typeof resolveApprovalSchema>;
export type RequestApprovalInput = z.infer<typeof requestApprovalSchema>;
export type SubmitApprovalInput = z.infer<typeof submitApprovalSchema>;
export type DealStage = z.infer<typeof dealStageSchema>;
export type LogActivityInput = z.infer<typeof logActivitySchema>;
export type PatchCustomDataInput = z.infer<typeof patchCustomDataSchema>;
export type CreateApprovalRuleInput = z.infer<typeof createApprovalRuleSchema>;
export type ApprovalsListInput = z.infer<typeof approvalsListSchema>;
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
export type CreateCompetitorInput = z.infer<typeof createCompetitorSchema>;
export type UpdateCompetitorInput = z.infer<typeof updateCompetitorSchema>;
export type PatchNextStepInput = z.infer<typeof patchNextStepSchema>;
export type CreateForecastSnapshotInput = z.infer<typeof createForecastSnapshotSchema>;
export type CompareForecastSnapshotsInput = z.infer<typeof compareForecastSnapshotsSchema>;
export type ForecastSnapshotsQueryInput = z.infer<typeof forecastSnapshotsQuerySchema>;
export type CreateStakeholderInput = z.infer<typeof createStakeholderSchema>;
export type UpdateStakeholderInput = z.infer<typeof updateStakeholderSchema>;
export type OverrideForecastSnapshotInput = z.infer<typeof overrideForecastSnapshotSchema>;
