import { z } from "zod";

export const lifecycleGroupSchema = z.enum([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);

export const createPositionStatusSchema = z
  .object({
    name: z.string().min(1).max(100),
    order: z.number().int().min(0).optional(),
    color: z.string().max(50).optional(),
    lifecycleGroup: lifecycleGroupSchema.optional(),
  })
  .strict();

export const updatePositionStatusSchema = createPositionStatusSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();

const positionRequiredFieldSchema = z.enum([
  "incumbentUserId",
  "departmentId",
  "budgetedCostCents",
  "jobLevelId",
]);

export const createPositionTransitionSchema = z
  .object({
    fromStatusId: z.number().int().positive().nullable().default(null),
    toStatusId: z.number().int().positive(),
    name: z.string().max(200).optional(),
    requiresApproval: z.boolean().optional(),
    requiredFields: z.array(positionRequiredFieldSchema).optional(),
    allowedRoles: z.array(z.string().max(100)).optional(),
  })
  .strict();

export const updatePositionTransitionSchema =
  createPositionTransitionSchema.partial().strict();

export type CreatePositionStatusInput = z.infer<
  typeof createPositionStatusSchema
>;
export type UpdatePositionStatusInput = z.infer<
  typeof updatePositionStatusSchema
>;
export type CreatePositionTransitionInput = z.infer<
  typeof createPositionTransitionSchema
>;
export type UpdatePositionTransitionInput = z.infer<
  typeof updatePositionTransitionSchema
>;
