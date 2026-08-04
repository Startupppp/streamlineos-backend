import { ORG_MEMBER_ROLE_VALUES } from "../../../../common/rbac/org-roles";
import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  billingEmail: z
    .string()
    .email()
    .max(255)
    .trim()
    .optional()
    .transform((v) => v ?? null),
});

export const listMembersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  userIds: z
    .string()
    .trim()
    .min(1)
    .transform((v) => v.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 50))
    .optional(),
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
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
  currency: z
    .enum(["USD", "EUR", "INR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY"])
    .optional(),
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
  industry: z.string().min(1).nullable().optional(),
  website: z.string().url().nullable().optional(),
  legalName: z.string().min(1).nullable().optional(),
  orgCode: z.string().min(1).max(20).nullable().optional(),
  registrationNumber: z.string().min(1).nullable().optional(),
  taxNumber: z.string().min(1).nullable().optional(),
  supportEmail: z.string().email().nullable().optional(),
  supportPhone: z.string().min(1).nullable().optional(),
  favicon: z.string().url().nullable().optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  language: z.string().min(2).max(10).optional(),
  dateFormat: z.string().min(1).optional(),
  timeFormat: z.enum(["12h", "24h"]).optional(),
  numberFormat: z.string().min(1).optional(),
  weekStartDay: z.enum(["monday", "sunday", "saturday"]).optional(),
  businessHours: z
    .record(
      z.string(),
      z.object({ open: z.string(), close: z.string(), enabled: z.boolean() }),
    )
    .optional(),
  companySize: z.string().min(1).nullable().optional(),
  country: z.string().min(1).nullable().optional(),
});

export const securitySettingsSchema = z.object({
  mfaEnforced: z.boolean().optional(),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
  maxConcurrentSessions: z.number().int().min(1).max(100).nullable().optional(),
  ipAllowlist: z.array(z.string().min(1).max(128)).max(100).optional(),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(ORG_MEMBER_ROLE_VALUES),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export const switchOrgSchema = z.object({
  orgId: z.string().min(1),
});

export const restoreOrgSchema = z.object({
  orgId: z.string().min(1),
});

export const deleteOrgSchema = z.object({
  confirmation: z.string().min(1).max(200),
});

export const addCustomDomainSchema = z.object({
  domain: z.string().min(1).max(253),
});

export const createHolidaySchema = z.object({
  name: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recurring: z.boolean().optional().default(false),
});

export const schedulePurgeSchema = z.object({
  scheduledForDays: z.number().int().min(1).max(365).default(30),
  reason: z.string().min(1).max(500),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;
export type SecuritySettingsInput = z.infer<typeof securitySettingsSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;
export type RestoreOrgInput = z.infer<typeof restoreOrgSchema>;
export type DeleteOrgInput = z.infer<typeof deleteOrgSchema>;
export type AddCustomDomainInput = z.infer<typeof addCustomDomainSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type SchedulePurgeInput = z.infer<typeof schedulePurgeSchema>;
