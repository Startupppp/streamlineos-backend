import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { approvalEntityTypeEnum, approvalStatusEnum } from "../../../../db/schema";

export const approvalInboxItemSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  projectKey: z.string().nullable(),
  entityType: z.enum(approvalEntityTypeEnum.enumValues),
  entityId: z.number().int(),
  title: z.string(),
  status: z.enum(approvalStatusEnum.enumValues),
  level: z.number().int(),
  dueAt: nullableWireDate(),
  requestedById: z.string().nullable(),
  decidedAt: nullableWireDate(),
});

export const approvalRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int().nullable(),
  entityType: z.enum(approvalEntityTypeEnum.enumValues),
  entityId: z.number().int(),
  title: z.string(),
  reason: z.string().nullable(),
  requestedById: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  status: z.enum(approvalStatusEnum.enumValues),
  level: z.number().int(),
  dueAt: nullableWireDate(),
  decisionComment: z.string().nullable(),
  decidedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

