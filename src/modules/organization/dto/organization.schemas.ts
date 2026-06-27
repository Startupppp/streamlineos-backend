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

export const updateOrgSettingsSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  logo: z.string().url().nullable().optional(),
  timezone: z.string().min(1).optional(),
  currency: z.enum(["USD", "EUR", "INR", "GBP", "AED"]).optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  directoryPublic: z.boolean().optional(),
  mfaEnforced: z.boolean().optional(),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  loginBgUrl: z.string().url().nullable().optional(),
  ipAllowlist: z.array(z.string().min(1)).optional(),
});

export const securitySettingsSchema = z.object({
  mfaEnforced: z.boolean().optional(),
  passwordExpiryDays: z.number().int().min(30).max(365).nullable().optional(),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.string().min(1),
});

export const updateMemberRoleSchema = z.object({
  role: z.string().min(1),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type CancelInvitationInput = z.infer<typeof cancelInvitationSchema>;
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;
export type SecuritySettingsInput = z.infer<typeof securitySettingsSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
