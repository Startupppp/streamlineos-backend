import { z } from "zod";
import { changeRequestStatusEnum } from "../../../../db/schema";

export const createChangeRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  impact: z.string().optional(),
  estimateMinutes: z.number().int().nonnegative().optional(),
  budgetImpactCents: z.number().int().optional(),
  timelineImpactDays: z.number().int().optional(),
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
}).strict();

export const listCrQuerySchema = z
  .object({
    status: z.enum(changeRequestStatusEnum.enumValues).optional(),
    impact: z.string().optional(),
    afterCreatedAt: z.iso.datetime().optional(),
    afterId: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) => (v.afterCreatedAt === undefined) === (v.afterId === undefined),
    { message: "afterCreatedAt and afterId must be supplied together or both omitted" },
  );

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type UpdateChangeRequestInput = z.infer<typeof updateChangeRequestSchema>;
export type ListCrQuery = z.infer<typeof listCrQuerySchema>;
