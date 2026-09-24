import { z } from "zod";
import {
  portfolioHealthEnum,
  portfolioStatusEnum,
  projectStatusEnum,
} from "../../../../db/schema";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const portfolioRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: z.enum(portfolioStatusEnum.enumValues),
  health: z.enum(portfolioHealthEnum.enumValues).nullable(),
  strategicGoal: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const portfolioListItemSchema = portfolioRowSchema.omit({ deletedAt: true }).extend({
  projectCount: z.number().int(),
});

export const portfolioPageSchema = cursorPageSchema(portfolioListItemSchema);

export const linkedProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  status: z.enum(projectStatusEnum.enumValues),
  openCount: z.number().int(),
  doneCount: z.number().int(),
});

export const linkedProjectPageSchema = cursorPageSchema(linkedProjectSchema);

export const linkedProgramSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.enum(portfolioStatusEnum.enumValues),
});

export const linkedProgramPageSchema = cursorPageSchema(linkedProgramSchema);

export const portfolioDetailSchema = portfolioRowSchema.extend({
  projects: linkedProjectPageSchema,
  programs: linkedProgramPageSchema,
});

export const programRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  portfolioId: z.number().int().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: z.enum(portfolioStatusEnum.enumValues),
  health: z.enum(portfolioHealthEnum.enumValues).nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const programLinkedProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  status: z.enum(projectStatusEnum.enumValues),
  addedAt: wireDate(),
});

export const programLinkedProjectPageSchema = cursorPageSchema(programLinkedProjectSchema);

export const programDetailSchema = programRowSchema.extend({
  projects: programLinkedProjectPageSchema,
});

export const programPageSchema = cursorPageSchema(
  programRowSchema.omit({ deletedAt: true }).extend({ projectCount: z.number().int() }),
);

export { successSchema };
