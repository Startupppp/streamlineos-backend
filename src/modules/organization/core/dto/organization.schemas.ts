import { ORG_MEMBER_ROLE_VALUES } from "../../../../common/rbac/org-roles";
import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

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
}).strict();

export const listMembersSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
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
}).strict();

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
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  loginBgUrl: z.string().url().nullable().optional(),
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
      z.object({ open: z.string(), close: z.string(), enabled: z.boolean() }).strict(),
    )
    .optional(),
  companySize: z.string().min(1).nullable().optional(),
  country: z.string().min(1).nullable().optional(),
}).strict();

export const securitySettingsSchema = z.object({
  mfaEnforced: z.boolean().optional(),
  allowedEmailDomains: z.array(z.string().min(1).max(253)).max(100).optional(),
  maxConcurrentSessions: z.number().int().min(1).max(100).nullable().optional(),
  ipAllowlist: z.array(z.string().min(1).max(128)).max(100).optional(),
}).strict();

export const updateMemberRoleSchema = z.object({
  role: z.enum(ORG_MEMBER_ROLE_VALUES),
}).strict();

export const requestInvitationOtpSchema = z.object({
  token: z.string().min(1),
}).strict();

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  emailOtp: z.string().length(6).optional(),
}).strict();

export const declineInvitationSchema = z.object({
  token: z.string().min(1),
}).strict();

export const switchOrgSchema = z.object({
  orgId: z.string().min(1),
}).strict();

export const restoreOrgSchema = z.object({
  orgId: z.string().min(1),
}).strict();

export const deleteOrgSchema = z.object({
  confirmation: z.string().min(1).max(200),
}).strict();

export const addCustomDomainSchema = z.object({
  domain: z.string().min(1).max(253),
}).strict();

export const createHolidaySchema = z.object({
  name: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recurring: z.boolean().optional().default(false),
}).strict();

export const schedulePurgeSchema = z.object({
  scheduledForDays: z.number().int().min(1).max(365).default(30),
  reason: z.string().min(1).max(500),
}).strict();

export const placeLegalHoldSchema = z.object({
  reason: z.string().min(1).max(500),
}).strict();

export const validateInvitationTokenQuerySchema = z
  .object({ token: z.string().min(1).max(512) })
  .strict();

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;
export type SecuritySettingsInput = z.infer<typeof securitySettingsSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type RequestInvitationOtpInput = z.infer<typeof requestInvitationOtpSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type DeclineInvitationInput = z.infer<typeof declineInvitationSchema>;
export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;
export type RestoreOrgInput = z.infer<typeof restoreOrgSchema>;
export type DeleteOrgInput = z.infer<typeof deleteOrgSchema>;
export type AddCustomDomainInput = z.infer<typeof addCustomDomainSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type SchedulePurgeInput = z.infer<typeof schedulePurgeSchema>;
export type PlaceLegalHoldInput = z.infer<typeof placeLegalHoldSchema>;
export type ValidateInvitationTokenQuery = z.infer<typeof validateInvitationTokenQuerySchema>;
