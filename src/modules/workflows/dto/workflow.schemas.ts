import { z } from "zod";

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(["draft", "published", "disabled", "archived"]).optional(),
});

export const PublishWorkflowSchema = z.object({
  definitionJson: z.record(z.string(), z.unknown()),
});

export const WorkflowExecutionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "timed_out"]).optional(),
});

export const WorkflowListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
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
