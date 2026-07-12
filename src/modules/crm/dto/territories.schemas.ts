import { z } from "zod";

const criteriaSchema = z.object({
  countries: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  cities: z.array(z.string()).optional(),
  postalCodes: z.array(z.string()).optional(),
  industries: z.array(z.string()).optional(),
  companySizes: z.array(z.string()).optional(),
  productKeys: z.array(z.string()).optional(),
  accountTypes: z.array(z.string()).optional(),
}).optional().default({});

export const territoryListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const territoryCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  states: z.array(z.string()).optional().default([]),
  cities: z.array(z.string()).optional().default([]),
  assignedReps: z.array(z.number()).optional().default([]),
  description: z.string().optional(),
  isActive: z.boolean().optional().default(true),
  criteria: criteriaSchema,
  priority: z.number().int().min(0).optional().default(0),
});

export const territoryUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  states: z.array(z.string()).optional(),
  cities: z.array(z.string()).optional(),
  assignedReps: z.array(z.number()).optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  criteria: z.object({
    countries: z.array(z.string()).optional(),
    states: z.array(z.string()).optional(),
    cities: z.array(z.string()).optional(),
    postalCodes: z.array(z.string()).optional(),
    industries: z.array(z.string()).optional(),
    companySizes: z.array(z.string()).optional(),
    productKeys: z.array(z.string()).optional(),
    accountTypes: z.array(z.string()).optional(),
  }).optional(),
  priority: z.number().int().min(0).optional(),
});

const sampleLeadSchema = z.object({
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  companySize: z.string().optional(),
  productKeys: z.array(z.string()).optional(),
  accountType: z.string().optional(),
});

export const territoryPreviewSchema = z.object({
  sample: sampleLeadSchema,
});

export type TerritoryListInput = z.infer<typeof territoryListSchema>;
export type TerritoryCreateInput = z.infer<typeof territoryCreateSchema>;
export type TerritoryUpdateInput = z.infer<typeof territoryUpdateSchema>;
export type TerritoryPreviewInput = z.infer<typeof territoryPreviewSchema>;
export type SampleLead = z.infer<typeof sampleLeadSchema>;
