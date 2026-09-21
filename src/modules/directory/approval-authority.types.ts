import type { hrWorkflowObjectTypeEnum } from "../../db/schema";
import type { ManagerAssignmentRefusal } from "./reporting-line.types";

type WorkflowObjectType = (typeof hrWorkflowObjectTypeEnum.enumValues)[number];

export const APPROVAL_REQUEST_KINDS = [
  "leave",
  "wfh",
  "attendance_correction",
  "overtime",
  "comp_off",
  "expense",
  "travel",
  "timesheet",
  "compensation",
  "exit",
  "hr_case",
] as const;

export type ApprovalRequestKind = (typeof APPROVAL_REQUEST_KINDS)[number];

export interface ApprovalKindPolicy {
  label: string;
  permission: string;
  queueLabel: string;
  slaHours: number;
  workflowObjectType: WorkflowObjectType | null;
}

export const APPROVAL_KIND_POLICIES: Readonly<Record<ApprovalRequestKind, ApprovalKindPolicy>> = {
  leave: { label: "leave", permission: "hr:leaves:approve", queueLabel: "HR approvals queue", slaHours: 48, workflowObjectType: "leave_request" },
  wfh: { label: "work-from-home", permission: "hr:attendance:manage", queueLabel: "HR attendance queue", slaHours: 24, workflowObjectType: null },
  attendance_correction: { label: "attendance correction", permission: "hr:attendance:manage", queueLabel: "HR attendance queue", slaHours: 48, workflowObjectType: "attendance_regularization" },
  overtime: { label: "overtime", permission: "hr:attendance:manage", queueLabel: "HR attendance queue", slaHours: 48, workflowObjectType: "overtime_request" },
  comp_off: { label: "compensatory off", permission: "hr:leaves:approve", queueLabel: "HR approvals queue", slaHours: 48, workflowObjectType: "comp_off_request" },
  expense: { label: "expense", permission: "hr:expenses:approve", queueLabel: "Expense approvals queue", slaHours: 72, workflowObjectType: "expense_reimbursement" },
  travel: { label: "travel", permission: "hr:travel:manage", queueLabel: "Travel approvals queue", slaHours: 72, workflowObjectType: "travel_request" },
  timesheet: { label: "timesheet", permission: "timesheets:approvals:manage", queueLabel: "Timesheet approvals queue", slaHours: 48, workflowObjectType: null },
  compensation: { label: "compensation change", permission: "hr:compensation:manage", queueLabel: "Compensation approvals queue", slaHours: 120, workflowObjectType: "salary_revision" },
  exit: { label: "exit", permission: "hr:exit:manage", queueLabel: "HR exits queue", slaHours: 120, workflowObjectType: "resignation" },
  hr_case: { label: "HR workflow", permission: "hr:workflows:approve", queueLabel: "HR workflow approvers", slaHours: 72, workflowObjectType: null },
};

export const HR_WORKFLOW_APPROVE_PERMISSION = "hr:workflows:approve";

export function approvalKindOfWorkflowObject(objectType: WorkflowObjectType): ApprovalRequestKind {
  if (objectType === "termination") return "exit";
  for (const kind of APPROVAL_REQUEST_KINDS)
    if (APPROVAL_KIND_POLICIES[kind].workflowObjectType === objectType) return kind;
  return "hr_case";
}

export const APPROVAL_QUEUE_MEMBER_CAP = 100;

export const APPROVAL_RUNGS = ["reporting_manager", "managers_manager", "department_head", "queue"] as const;

export type ApprovalRung = (typeof APPROVAL_RUNGS)[number];

export type ApprovalRungSkipReason =
  | "no-manager"
  | "no-department-head"
  | "self"
  | "lacks-permission"
  | "queue-empty"
  | ManagerAssignmentRefusal;

export interface ApprovalCandidate {
  userId: string;
  membershipId: number;
  name: string | null;
  email: string;
  designation: string | null;
}

export interface SkippedApprovalRung {
  rung: ApprovalRung;
  userId: string | null;
  reason: ApprovalRungSkipReason;
}

export interface ApprovalDelegation {
  source: "workflow" | "permission";
  delegationId: string;
  fromUserId: string;
  toUserId: string;
  endsAt: string;
  reason: string | null;
}

export interface ApprovalQueue {
  permission: string;
  label: string;
  memberCount: number;
  members: ApprovalCandidate[];
}

export interface ApprovalEscalation {
  rung: ApprovalRung;
  approver: ApprovalCandidate | null;
  queue: ApprovalQueue | null;
}

export interface ApprovalResolveOptions {
  at?: Date;
  permission?: string;
  from?: ApprovalRung;
}

export interface ApprovalRoute {
  kind: ApprovalRequestKind;
  subjectUserId: string;
  permission: string;
  resolvedAt: string;
  rung: ApprovalRung | null;
  assignedTo: ApprovalCandidate | null;
  approver: ApprovalCandidate | null;
  delegation: ApprovalDelegation | null;
  queue: ApprovalQueue | null;
  skipped: SkippedApprovalRung[];
  slaHours: number;
  dueAt: string;
  escalation: ApprovalEscalation | null;
  explanation: string;
}

export function isApprovalRequestKind(value: string): value is ApprovalRequestKind {
  return APPROVAL_REQUEST_KINDS.some((kind) => kind === value);
}
