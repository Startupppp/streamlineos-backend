import { z } from "zod";
import { APPROVAL_REQUEST_KINDS, APPROVAL_RUNGS } from "../approval-authority.types";

export const approvalRequestKindSchema = z.enum(APPROVAL_REQUEST_KINDS);

const approvalRungSchema = z.enum(APPROVAL_RUNGS);

const approvalRungSkipReasonSchema = z.enum([
  "no-manager",
  "no-department-head",
  "self",
  "lacks-permission",
  "queue-empty",
  "self-reference",
  "manager-not-in-organization",
  "manager-inactive",
  "manager-has-no-employment",
  "manager-exited",
  "circular",
]);

export const approvalCandidateSchema = z.object({
  userId: z.string(),
  membershipId: z.number().int(),
  name: z.string().nullable(),
  email: z.string(),
  designation: z.string().nullable(),
});

const approvalQueueSchema = z.object({
  permission: z.string(),
  label: z.string(),
  memberCount: z.number().int(),
  members: z.array(approvalCandidateSchema),
});

export const approvalRouteSchema = z.object({
  kind: approvalRequestKindSchema,
  subjectUserId: z.string(),
  permission: z.string(),
  resolvedAt: z.string(),
  rung: approvalRungSchema.nullable(),
  assignedTo: approvalCandidateSchema.nullable(),
  approver: approvalCandidateSchema.nullable(),
  delegation: z
    .object({
      source: z.enum(["workflow", "permission"]),
      delegationId: z.string(),
      fromUserId: z.string(),
      toUserId: z.string(),
      endsAt: z.string(),
      reason: z.string().nullable(),
    })
    .nullable(),
  queue: approvalQueueSchema.nullable(),
  skipped: z.array(z.object({ rung: approvalRungSchema, userId: z.string().nullable(), reason: approvalRungSkipReasonSchema })),
  slaHours: z.number().int(),
  dueAt: z.string(),
  escalation: z.object({ rung: approvalRungSchema, approver: approvalCandidateSchema.nullable(), queue: approvalQueueSchema.nullable() }).nullable(),
  explanation: z.string(),
});

export const approvalRouteKindParamsSchema = z.object({ kind: approvalRequestKindSchema }).strict();
