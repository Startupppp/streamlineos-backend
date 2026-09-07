import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const kpiSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  unit: z.string().nullable(),
  target: z.string().nullable(),
  type: z.string(),
  ownerId: z.string().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  period: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const competencySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  frameworkId: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  level: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const frameworkSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listKpisResponseSchema = z.array(kpiSchema);

export const createKpiResponseSchema = z.array(kpiSchema);

export const updateKpiResponseSchema = z.array(kpiSchema);

export const listFrameworksResponseSchema = z.array(
  frameworkSchema.extend({
    competencies: z.array(competencySchema),
  }),
);

export const createFrameworkResponseSchema = z.array(frameworkSchema);

export const updateFrameworkResponseSchema = z.array(frameworkSchema);

export const listCompetenciesResponseSchema = z.array(competencySchema);

export const createCompetencyResponseSchema = z.array(competencySchema);
