import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/** Full `workflows` table row (bare `.returning()`). */
export const workflowRowSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["draft", "published", "disabled", "archived"]),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `workflows-crud.service.ts` `getWorkflow` — projected row + versions. */
export const getWorkflowResponseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["draft", "published", "disabled", "archived"]),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  createdByName: z.string().nullable(),
  createdByEmail: z.string().nullable(),
  versions: z.array(
    z.object({
      id: z.string().uuid(),
      orgId: z.string(),
      workflowId: z.string().uuid(),
      version: z.number().int(),
      definitionJson: z.record(z.string(), z.unknown()),
      publishedBy: z.string().nullable(),
      publishedAt: nullableWireDate(),
      createdAt: wireDate(),
    }),
  ),
});

/** `workflows-crud.service.ts` `listWorkflows` — `buildCursorPage` of workflow rows. */
export const listWorkflowsResponseSchema = cursorPageSchema(workflowRowSchema);

/** `workflow_versions` table row. */
const workflowVersionRowSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  workflowId: z.string().uuid(),
  version: z.number().int(),
  definitionJson: z.record(z.string(), z.unknown()),
  publishedBy: z.string().nullable(),
  publishedAt: nullableWireDate(),
  createdAt: wireDate(),
});

/** `workflows-crud.service.ts` `publishWorkflow` — `{workflow, version}`. */
export const publishWorkflowResponseSchema = z.object({
  workflow: workflowRowSchema,
  version: workflowVersionRowSchema,
});

/** Full `workflow_executions` table row (bare `.returning()`). */
export const workflowExecutionRowSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  workflowVersionId: z.string().uuid(),
  orgId: z.string(),
  status: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "timed_out", "dead_lettered"]),
  triggerType: z.enum(["event", "schedule", "webhook", "api", "manual"]).nullable(),
  triggerData: z.record(z.string(), z.unknown()).nullable(),
  context: z.record(z.string(), z.unknown()).nullable(),
  startedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  durationMs: z.number().int().nullable(),
  triggeredBy: z.string().nullable(),
  dlqReason: z.string().nullable(),
  createdAt: wireDate(),
});

/** `workflows-execution.service.ts` `listExecutions` / `listAllExecutions` — `buildCursorPage`. */
export const listExecutionsResponseSchema = cursorPageSchema(workflowExecutionRowSchema);

/** `workflow_execution_steps` row shape used in `getExecution`. */
const workflowExecutionStepSchema = z.object({
  id: z.string().uuid(),
  executionId: z.string().uuid(),
  orgId: z.string(),
  nodeId: z.string(),
  nodeType: z.enum(["trigger", "condition", "approval", "action", "delay", "loop", "ai_action", "integration", "script", "end"]),
  status: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "timed_out", "dead_lettered"]),
  input: z.record(z.string(), z.unknown()).nullable(),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  startedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  durationMs: z.number().int().nullable(),
  createdAt: wireDate(),
});

/** `workflows-execution.service.ts` `getExecution` — execution row + steps. */
export const getExecutionResponseSchema = workflowExecutionRowSchema.extend({
  steps: z.array(workflowExecutionStepSchema),
});

/** `workflow_approvals` table row (bare `.returning()`). */
export const workflowApprovalRowSchema = z.object({
  id: z.string().uuid(),
  executionId: z.string().uuid(),
  stepId: z.string().uuid(),
  orgId: z.string(),
  approverId: z.string(),
  status: z.enum(["pending", "approved", "rejected", "delegated", "expired"]),
  comment: z.string().nullable(),
  approvedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
});

/** `workflows-approval.service.ts` `getApprovals` — mapped array with ISO date strings. */
export const getPendingApprovalsResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    executionId: z.string().uuid(),
    stepId: z.string().uuid(),
    approverId: z.string(),
    status: z.string(),
    comment: z.string().nullable(),
    approvedAt: z.string().nullable(),
    rejectedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    workflow: z.object({ id: z.string().uuid(), name: z.string() }),
  }),
);

/** `workflow_schedules` table row (bare `.returning()`). */
export const workflowScheduleRowSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  orgId: z.string(),
  cronExpression: z.string(),
  timezone: z.string(),
  isEnabled: z.boolean(),
  nextRunAt: nullableWireDate(),
  lastRunAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `workflows-schedules.service.ts` `listSchedules` / `listAllSchedules` — `buildCursorPage`. */
export const listSchedulesResponseSchema = cursorPageSchema(workflowScheduleRowSchema);

/** Secret columns returned by `createSecret`, `createGlobalSecret`, `listSecrets`, `listGlobalSecrets`. */
export const workflowSecretRowSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `listSecrets` / `listGlobalSecrets` — `buildCursorPage` of secret rows. */
export const listSecretsResponseSchema = cursorPageSchema(workflowSecretRowSchema);

/** `workflows-variables.service.ts` `listGlobalVariables` — projected join rows. */
export const listGlobalVariablesResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    key: z.string(),
    valueType: z.string(),
    defaultValue: z.unknown().nullable(),
    workflowVersionId: z.string().uuid(),
    createdAt: wireDate(),
    workflowId: z.string().uuid(),
    workflowName: z.string(),
  }),
);

/** `workflows-analytics.service.ts` `getAnalytics`. */
export const workflowAnalyticsResponseSchema = z.object({
  totalWorkflows: z.number().int(),
  activeWorkflows: z.number().int(),
  totalExecutions: z.number().int(),
  successRate: z.number().int(),
  avgDuration: z.number().int(),
  pendingApprovals: z.number().int(),
  executionTrend: z.array(
    z.object({
      date: z.string(),
      count: z.number().int(),
      successCount: z.number().int(),
    }),
  ),
});

/** `workflows-cron.controller.ts` `runSweep`. */
export const workflowSweepResultSchema = z.object({
  claimed: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  suspended: z.number().int(),
  deadLettered: z.number().int(),
  stepsPruned: z.number().int(),
});

/** `workflows-cron.controller.ts` `tickSchedules`. */
export const schedulesTickResultSchema = z.object({
  orgsScanned: z.number().int(),
  schedulesTriggered: z.number().int(),
  schedulesFailed: z.number().int(),
});
