import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
});

export const listMembersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
});

export const cancelInvitationSchema = z.object({
  invitationId: z.string(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type CancelInvitationInput = z.infer<typeof cancelInvitationSchema>;
