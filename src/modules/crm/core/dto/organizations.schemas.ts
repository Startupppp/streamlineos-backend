import { z } from "zod";

const sizeEnum = z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]);

export const organizationListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(200).optional(),
  search: z.string().trim().max(200).optional(),
});

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  domain: z.string().optional(),
  industry: z.string().optional(),
  size: sizeEnum.optional(),
  website: z.string().url().optional().or(z.literal("")),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  description: z.string().optional(),
}).strict();

export const organizationUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  size: sizeEnum.optional().nullable(),
  website: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  healthScore: z.number().int().min(0).max(100).optional().nullable(),
  parentId: z.number().int().positive().optional().nullable(),
  notes: z.string().optional().nullable(),
}).strict();

export type OrganizationListInput = z.infer<typeof organizationListSchema>;
export type OrganizationCreateInput = z.infer<typeof organizationCreateSchema>;
export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>;
