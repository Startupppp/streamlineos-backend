import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const portfolioRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: z.string(),
  health: z.string().nullable(),
  strategicGoal: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const portfolioListItemSchema = portfolioRowSchema.extend({
  projectCount: z.number().int(),
});

export const portfolioPageSchema = cursorPageSchema(portfolioListItemSchema);

export const portfolioDetailSchema = portfolioRowSchema.extend({
  projects: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    key: z.string(),
    status: z.string(),
    openCount: z.number().int(),
    doneCount: z.number().int(),
  })),
  programs: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
  })),
});

export const programRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  portfolioId: z.number().int().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: z.string(),
  health: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const programDetailSchema = programRowSchema.extend({
  projects: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    key: z.string(),
    status: z.string(),
    addedAt: wireDate(),
  })),
});

export const programPageSchema = cursorPageSchema(programRowSchema);

export { successSchema };
