import { z } from "zod";
import { changeRequestStatusEnum } from "../../../../db/schema";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";

export const createChangeRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
  releaseId: z.number().int().positive().optional(),
  clientVisible: z.boolean().optional(),
}).strict();

export const updateChangeRequestSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
  status: z.enum(changeRequestStatusEnum.enumValues).optional(),
  approvalOwnerId: z.string().optional(),
  decisionComment: z.string().optional(),
  releaseId: z.number().int().positive().nullable().optional(),
  clientVisible: z.boolean().optional(),
}).strict();

export const listCrQuerySchema = z
  .object({
    status: z.enum(changeRequestStatusEnum.enumValues).optional(),
    impact: z.string().optional(),
    requesterId: z.string().optional(),
    approverId: z.string().optional(),
    releaseId: z.coerce.number().int().positive().optional(),
    clientVisible: z
      .string()
      .transform((v) => v === "true")
      .pipe(z.boolean())
      .optional(),
    q: z.string().max(200).optional(),
    affectedTicketId: z.coerce.number().int().positive().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_SIZE_CAP).optional(),
  })
  .strict();

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type UpdateChangeRequestInput = z.infer<typeof updateChangeRequestSchema>;
export type ListCrQuery = z.infer<typeof listCrQuerySchema>;
