import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const supportMacroRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  body: z.string(),
  category: z.string().nullable(),
  visibility: z.string(),
  actions: z.record(z.string(), z.unknown()),
  usageCount: z.number().int(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportMacroListSchema = z.array(supportMacroRowSchema);

export const macroUsageSchema = z.array(
  z.object({ id: z.number().int(), title: z.string(), usageCount: z.number().int() }),
);

export const previewMacroSchema = z.object({ body: z.string() });

export const applyMacroResultSchema = z.object({
  body: z.string(),
  isInternal: z.boolean(),
  actionsApplied: z.record(z.string(), z.unknown()),
});

export const supportRoutingRuleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  conditions: z.array(z.unknown()),
  assigneeMembershipId: z.number().int().nullable(),
  setPriority: z.string().nullable(),
  assignmentMode: z.string(),
  candidateAgentIds: z.array(z.string()),
  requiredSkills: z.array(z.string()),
  isEnabled: z.boolean(),
  sortOrder: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportRoutingRuleListSchema = z.array(supportRoutingRuleRowSchema);

export const supportAgentSkillRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  userMembershipId: z.number().int(),
  skill: z.string(),
  createdAt: wireDate(),
});

export const supportAgentSkillListSchema = z.array(supportAgentSkillRowSchema);

export const setAgentSkillsResultSchema = z.object({
  success: z.literal(true),
  skills: z.array(z.string()),
});

export const supportAgentAvailabilityRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  userMembershipId: z.number().int(),
  isAvailable: z.boolean(),
  updatedAt: wireDate(),
});

export const supportAgentAvailabilityListSchema = z.array(supportAgentAvailabilityRowSchema);

export const supportAgentAvailabilityRawSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int(),
  isAvailable: z.boolean(),
  updatedAt: wireDate(),
});

export const supportVipClientRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  clientId: z.number().int(),
  createdAt: wireDate(),
});

export const supportVipClientListSchema = z.array(supportVipClientRowSchema);

export const supportBusinessHoursRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  timezone: z.string(),
  weeklySchedule: z.record(z.string(), z.unknown()),
  holidays: z.array(z.string()),
  is24x7: z.boolean(),
  isDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportBusinessHoursListSchema = z.array(supportBusinessHoursRowSchema);

export const supportSlaPolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).nullable(),
  category: z.string().nullable(),
  businessHoursId: z.number().int().nullable(),
  firstResponseTargetMins: z.number().int(),
  resolutionTargetMins: z.number().int(),
  pauseStatuses: z.array(z.string()),
  isEnabled: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportSlaPolicyListSchema = z.array(supportSlaPolicyRowSchema);

export const runEscalationsResultSchema = z.object({
  checked: z.number().int(),
  escalated: z.number().int(),
});

export const supportSettingsAuditLogRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
});

export const supportSettingsAuditLogListSchema = z.array(supportSettingsAuditLogRowSchema);

export const ticketRiskSchema = z.object({
  risk: z.enum([
    "ok", "first_response_due_soon", "first_response_breached",
    "resolution_due_soon", "resolution_breached", "paused",
  ]),
});

export const supportCustomFieldSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  key: z.string(),
  label: z.string(),
  fieldType: z.string(),
  options: z.array(z.string()).nullable(),
  required: z.boolean(),
  category: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportCustomFieldListSchema = z.array(supportCustomFieldSchema);

export const ticketFieldValueListSchema = z.array(
  z.object({
    fieldId: z.number().int(),
    value: z.string().nullable(),
    key: z.string(),
    label: z.string(),
    fieldType: z.string(),
  }),
);

export { successSchema };
