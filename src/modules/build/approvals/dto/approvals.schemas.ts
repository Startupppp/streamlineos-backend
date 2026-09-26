import { z } from "zod";
import { approvalEntityTypeEnum, approvalStatusEnum } from "../../../../db/schema";

export const createApprovalSchema = z.object({
  entityType: z.enum(approvalEntityTypeEnum.enumValues),
  entityId: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  approverId: z.string().min(1),
  reason: z.string().max(2000).optional(),
  dueAt: z.coerce.date().optional(),
  level: z.number().int().min(1).optional(),
}).strict();

export const listApprovalsQuerySchema = z.object({
  status: z.enum(approvalStatusEnum.enumValues).optional(),
  entityType: z.enum(approvalEntityTypeEnum.enumValues).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export const inboxQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  status: z.enum(approvalStatusEnum.enumValues).optional(),
  type: z.enum(approvalEntityTypeEnum.enumValues).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().optional(),
}).strict();

export const decideApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected", "changes_requested"]),
  decisionComment: z.string().optional(),
}).strict();

export const updateApprovalSchema = z.object({
  approverId: z.string().min(1).optional(),
  dueAt: z.coerce.date().nullish(),
  status: z.enum(approvalStatusEnum.enumValues).optional(),
}).strict();

export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
export type UpdateApprovalInput = z.infer<typeof updateApprovalSchema>;
