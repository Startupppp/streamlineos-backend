import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

const HR_WORKFLOW_OBJECT_TYPES = [
  "leave_request", "attendance_regularization", "overtime_request", "comp_off_request",
  "expense_reimbursement", "travel_request", "employee_data_change", "document_review",
  "asset_request", "onboarding", "offboarding", "probation_confirmation", "promotion",
  "transfer", "salary_revision", "resignation", "termination", "grievance_case",
] as const;

const HR_WORKFLOW_APPROVER_TYPES = [
  "direct_manager", "managers_manager", "hr_role", "finance_role",
  "department_head", "location_hr", "named_user", "dynamic_expression",
] as const;

const HR_WORKFLOW_STEP_MODES = ["serial", "parallel_all", "parallel_any"] as const;

export const HrWorkflowStepSchema = z.object({
  stepOrder: z.number().int().min(1),
  name: z.string().min(1).max(200),
  approverType: z.enum(HR_WORKFLOW_APPROVER_TYPES),
  approverValue: z.string().optional(),
  mode: z.enum(HR_WORKFLOW_STEP_MODES).default("serial"),
  slaHours: z.number().int().positive().optional(),
  escalationApproverType: z.enum(HR_WORKFLOW_APPROVER_TYPES).optional(),
  escalationApproverValue: z.string().optional(),
  condition: z.object({
    field: z.string(),
    operator: z.enum(["eq", "gt", "lt", "gte", "lte", "in"]),
    value: z.unknown(),
  }).nullable().optional(),
});

export const CreateWorkflowDefinitionSchema = z.object({
  objectType: z.enum(HR_WORKFLOW_OBJECT_TYPES),
  name: z.string().min(1).max(200),
  isDefault: z.boolean().optional().default(false),
  settings: z.object({
    rejectionCommentRequired: z.boolean().optional(),
    allowDelegation: z.boolean().optional(),
    allowReopen: z.boolean().optional(),
  }).optional().default({}),
  steps: z.array(HrWorkflowStepSchema).min(1).max(20),
}).strict();

export const UpdateWorkflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isDefault: z.boolean().optional(),
  settings: z.object({
    rejectionCommentRequired: z.boolean().optional(),
    allowDelegation: z.boolean().optional(),
    allowReopen: z.boolean().optional(),
  }).optional(),
  steps: z.array(HrWorkflowStepSchema).min(1).max(20).optional(),
}).strict();

export const WorkflowDefinitionQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
  objectType: z.enum(HR_WORKFLOW_OBJECT_TYPES).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
}).strict();

export const WorkflowInstanceQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(50, 100),
  status: z.enum(["pending", "in_progress", "approved", "rejected", "cancelled", "reopened"]).optional(),
  objectType: z.enum(HR_WORKFLOW_OBJECT_TYPES).optional(),
}).strict();

export const WorkflowActedQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(50, 100),
  })
  .strict();

export const ActOnInstanceSchema = z.object({
  comment: z.string().optional(),
  attachments: z.array(z.object({ url: z.string().url(), name: z.string() })).optional(),
}).strict();

export const RejectInstanceSchema = z.object({
  comment: z.string().min(1, "Rejection comment is required"),
  attachments: z.array(z.object({ url: z.string().url(), name: z.string() })).optional(),
}).strict();

export const CreateDelegationSchema = z.object({
  delegateUserId: z.string().min(1),
  objectType: z.enum(HR_WORKFLOW_OBJECT_TYPES).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().optional(),
}).strict();

export const UpdateDelegationSchema = z.object({
  active: z.boolean().optional(),
  endsAt: z.string().datetime().optional(),
  reason: z.string().optional(),
}).strict();

export type CreateWorkflowDefinitionDto = z.infer<typeof CreateWorkflowDefinitionSchema>;
export type UpdateWorkflowDefinitionDto = z.infer<typeof UpdateWorkflowDefinitionSchema>;
export type WorkflowDefinitionQueryDto = z.infer<typeof WorkflowDefinitionQuerySchema>;
export type WorkflowInstanceQueryDto = z.infer<typeof WorkflowInstanceQuerySchema>;
export type WorkflowActedQueryDto = z.infer<typeof WorkflowActedQuerySchema>;
export type ActOnInstanceDto = z.infer<typeof ActOnInstanceSchema>;
export type RejectInstanceDto = z.infer<typeof RejectInstanceSchema>;
export type CreateDelegationDto = z.infer<typeof CreateDelegationSchema>;

export const SimulateWorkflowSchema = z.object({
  subjectEmployeeId: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

export type SimulateWorkflowDto = z.infer<typeof SimulateWorkflowSchema>;
export type UpdateDelegationDto = z.infer<typeof UpdateDelegationSchema>;

export const PaginationSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});

export type PaginationDto = z.infer<typeof PaginationSchema>;
