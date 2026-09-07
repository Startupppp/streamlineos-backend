import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export { successSchema };

const hrPolicyScopeRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  policyId: z.number().int(),
  scopeType: z.string(),
  scopeValue: z.string(),
  createdAt: wireDate(),
});

export const hrPolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  policyType: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  version: z.number().int(),
  parentPolicyId: z.number().int().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  rules: z.record(z.string(), z.unknown()),
  priority: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  scopes: z.array(hrPolicyScopeRowSchema),
});

export const hrPolicyListSchema = z.object({
  data: z.array(hrPolicyRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const hrPolicySeedResultSchema = z.object({
  seeded: z.boolean(),
  count: z.number().int().optional(),
  message: z.string().optional(),
});

const policyConflictSchema = z.object({
  severity: z.enum(["blocking", "warning"]),
  reason: z.string(),
  policyId: z.number().int(),
  policyName: z.string(),
  otherPolicyId: z.number().int(),
  otherPolicyName: z.string(),
  scopeOverlap: z.array(z.object({ scopeType: z.string(), scopeValue: z.string() })),
});

export const hrPolicyConflictsSchema = z.object({
  conflicts: z.array(policyConflictSchema),
  canActivate: z.boolean(),
});

export const hrPolicyOrgConflictsSchema = z.object({
  conflicts: z.array(policyConflictSchema),
});

const policyEvaluationTraceSchema = z.object({
  policyId: z.number().int(),
  policyName: z.string(),
  version: z.number().int(),
  matchedScopes: z.array(
    z.object({ scopeType: z.string(), scopeValue: z.string(), specificity: z.number() }),
  ),
  maxSpecificity: z.number(),
  priority: z.number().int(),
});

const policyEvaluationResultSchema = z.object({
  policy: z.object({
    id: z.number().int(),
    name: z.string(),
    policyType: z.string(),
    version: z.number().int(),
    status: z.string(),
    effectiveFrom: z.string(),
    effectiveTo: z.string().nullable(),
    priority: z.number().int(),
    rules: z.record(z.string(), z.unknown()),
  }),
  rules: z.record(z.string(), z.unknown()),
  trace: policyEvaluationTraceSchema,
});

export const hrPolicySimulateSchema = z.object({
  date: z.string(),
  employeeId: z.string(),
  policyType: z.string(),
  matched: policyEvaluationResultSchema.nullable(),
  simulatedRules: z.unknown(),
  explanation: z.string(),
});

export const hrPolicyPreviewSchema = policyEvaluationResultSchema.nullable();
