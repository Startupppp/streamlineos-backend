import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  // "published" is deliberately absent: it is reachable only through POST /:id/publish, which gates on workflows:workflows:publish.
  status: z.enum(["draft", "disabled", "archived"]).optional(),
});

export const PublishWorkflowSchema = z.object({
  definitionJson: z.record(z.string(), z.unknown()),
  /**
   * Optional optimistic-lock guard. When provided the backend compares this
   * against the current `workflows.version` and returns 409 if they differ,
   * surfacing a concurrent-edit conflict to the editor instead of silently
   * overwriting the other user's publish.
   */
  expectedVersion: z.number().int().positive().optional(),
});

export const WorkflowExecutionQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  direction: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "timed_out"]).optional(),
});

export const WorkflowListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  sort: z.enum(["updatedAt", "createdAt"]).default("updatedAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(["draft", "published", "disabled", "archived"]).optional(),
  search: z.string().optional(),
});

export const TriggerWorkflowSchema = z.object({
  triggerData: z.record(z.string(), z.unknown()).optional(),
});

export const ApprovalActionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().optional(),
});

export const CreateScheduleSchema = z.object({
  cronExpression: z.string().min(1),
  timezone: z.string().default("UTC"),
  isEnabled: z.boolean().default(true),
});

export const UpdateScheduleSchema = z.object({
  cronExpression: z.string().min(1).optional(),
  timezone: z.string().optional(),
  isEnabled: z.boolean().optional(),
});

export const CreateSecretSchema = z.object({
  name: z.string().min(1).max(255).regex(/^[A-Z_][A-Z0-9_]*$/),
  value: z.string().min(1),
  description: z.string().optional(),
});

export const ScheduleListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50),
}).strict();

export const SecretListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50),
}).strict();

export type CreateWorkflowDto = z.infer<typeof CreateWorkflowSchema>;
export type UpdateWorkflowDto = z.infer<typeof UpdateWorkflowSchema>;
export type PublishWorkflowDto = z.infer<typeof PublishWorkflowSchema>;
export type WorkflowExecutionQueryDto = z.infer<typeof WorkflowExecutionQuerySchema>;
export type WorkflowListQueryDto = z.infer<typeof WorkflowListQuerySchema>;
export type TriggerWorkflowDto = z.infer<typeof TriggerWorkflowSchema>;
export type ApprovalActionDto = z.infer<typeof ApprovalActionSchema>;
export type CreateScheduleDto = z.infer<typeof CreateScheduleSchema>;
export type UpdateScheduleDto = z.infer<typeof UpdateScheduleSchema>;
export type CreateSecretDto = z.infer<typeof CreateSecretSchema>;
export type ScheduleListQueryDto = z.infer<typeof ScheduleListQuerySchema>;
export type SecretListQueryDto = z.infer<typeof SecretListQuerySchema>;
