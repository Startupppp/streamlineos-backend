import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const assignmentRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  conditions: z.unknown(),
  assignmentType: z.string(),
  assignToUserId: z.string().nullable(),
  assignToMembershipId: z.number().int().nullable(),
  roundRobinUserIds: z.unknown(),
  priority: z.number().int(),
  isActive: z.boolean(),
  config: z.unknown(),
  assignmentTypeText: z.string().nullable(),
  createdAt: wireDate(),
});

export const scoringRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  field: z.string(),
  operator: z.string(),
  value: z.string(),
  points: z.number().int(),
  dimension: z.string(),
  createdAt: wireDate(),
});

export const emailTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const assignmentPreviewSchema = z.object({
  matchedRule: z
    .object({ id: z.number().int(), name: z.string() })
    .nullable(),
  wouldAssignTo: z.string().nullable(),
  trace: z.array(
    z.object({
      ruleId: z.number().int(),
      ruleName: z.string(),
      matched: z.boolean(),
      reason: z.string(),
    }),
  ),
});
