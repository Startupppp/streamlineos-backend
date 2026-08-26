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

/**
 * The merge and duplicate payloads, moved here when `crm-org-merge.service.ts`
 * was retired. They describe organizations, and there is no second service left
 * for them to belong to.
 */
export const mergeOrgsSchema = z.object({
  primaryId: z.number().int().positive(),
  duplicateId: z.number().int().positive(),
}).strict().refine((v) => v.primaryId !== v.duplicateId, {
  message: "primaryId and duplicateId must differ",
});

export const orgDuplicatesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** At least one discriminator is required — an empty check would match every org. */
export const orgDuplicateCheckSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    domain: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.name || v.domain), {
    message: "Provide a name or a domain to check",
  });

export type MergeOrgsInput = z.infer<typeof mergeOrgsSchema>;
export type OrgDuplicatesQueryInput = z.infer<typeof orgDuplicatesQuerySchema>;
export type OrgDuplicateCheckInput = z.infer<typeof orgDuplicateCheckSchema>;

export type OrganizationListInput = z.infer<typeof organizationListSchema>;
export type OrganizationCreateInput = z.infer<typeof organizationCreateSchema>;
export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>;
