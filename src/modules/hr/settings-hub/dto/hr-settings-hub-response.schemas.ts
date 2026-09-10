import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const policyEvaluationTraceSchema = z.object({
  policyId: z.number().int(),
  policyName: z.string(),
  version: z.number().int(),
  matchedScopes: z.array(z.object({ scopeType: z.string(), scopeValue: z.string(), specificity: z.number() })),
  maxSpecificity: z.number(),
  priority: z.number().int(),
});

export const effectiveRulesItemSchema = z.object({
  policyType: z.string(),
  matchedPolicy: z.object({
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

export const effectiveRulesResponseSchema = z.array(effectiveRulesItemSchema);

export const policyVersionItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  status: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  priority: z.number().int(),
  parentPolicyId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const templateVersionItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  status: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  parentTemplateId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const workflowVersionItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  status: z.string(),
  objectType: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const versionsResponseSchema = z.discriminatedUnion("entity", [
  z.object({ entity: z.literal("policy"), name: z.string(), items: z.array(policyVersionItemSchema) }),
  z.object({ entity: z.literal("template"), name: z.string(), items: z.array(templateVersionItemSchema) }),
  z.object({ entity: z.literal("workflow"), name: z.string(), items: z.array(workflowVersionItemSchema) }),
]);
