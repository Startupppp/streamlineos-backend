import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import { ORG_MEMBER_ROLES, ORG_MEMBER_ROLE_VALUES} from "../../../common/rbac/org-roles";

export const listUsersSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  search: z.string().optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
  role: z.string().optional(),
  departmentId: z.string().optional(),
  branchId: z.string().optional(),
  teamId: z.string().optional(),
  managerUserId: z.string().optional(),
  sortBy: z.enum(["name", "joinedAt", "status"]).default("joinedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});
export type ListUsersInput = z.infer<typeof listUsersSchema>;

const emergencyContactSchema = z.object({
  name: z.string().min(1),
  relation: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
}).optional();

export const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  designation: z.string().optional(),
  phone: z.string().optional(),
  departmentId: z.string().optional(),
  role: z.enum(ORG_MEMBER_ROLE_VALUES).optional(),
  bio: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  twitterUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  reportingTo: z.string().optional(),
  teamId: z.string().optional().nullable(),
  emergencyContact: emergencyContactSchema,
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateUserStatusSchema = z.object({
  status: z.enum(["active", "suspended", "archived"]),
  reason: z.string().optional(),
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

export const canonicalEmailSchema = z
  .string()
  .trim()
  .min(1)
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

const inviteEmailSchema = canonicalEmailSchema;

export const inviteUserSchema = z.object({
  email: inviteEmailSchema,
  role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const bulkInviteSchema = z.object({
  emails: z.array(inviteEmailSchema).min(1).max(500),
  role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
});
export type BulkInviteInput = z.infer<typeof bulkInviteSchema>;

export const updatePreferencesSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  language: z.string().optional(),
  timezone: z.string().optional(),
  dateFormat: z.string().optional(),
  timeFormat: z.enum(["12h", "24h"]).optional(),
  numberFormat: z.string().optional(),
  weekStartDay: z.enum(["sunday", "monday", "saturday"]).optional(),
  notificationPreferences: z.record(z.string(), z.boolean()).optional(),
  dashboardPreferences: z.record(z.string(), z.unknown()).optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export const updateMembershipSchema = z.object({
  businessUnitId: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  managerUserId: z.string().optional().nullable(),
});
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;

export const bulkActionSchema = z.object({
  userIds: z.array(z.string()).min(1).max(200),
  reason: z.string().optional(),
});
export type BulkActionInput = z.infer<typeof bulkActionSchema>;

export const listLoginHistorySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  success: z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true")),
});
export type ListLoginHistoryInput = z.infer<typeof listLoginHistorySchema>;

export const importUsersRowSchema = z.object({
  email: canonicalEmailSchema,
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
  designation: z.string().optional(),
  phone: z.string().optional(),
});
export type ImportUsersRow = z.infer<typeof importUsersRowSchema>;

export const bulkUpdateUsersSchema = z.object({
  userIds: z.array(z.string()).min(1).max(200),
  role: z.enum(ORG_MEMBER_ROLE_VALUES).optional(),
  departmentId: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  managerUserId: z.string().optional().nullable(),
});
export type BulkUpdateUsersInput = z.infer<typeof bulkUpdateUsersSchema>;

export const createUserSchema = z.object({
  email: canonicalEmailSchema,
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(ORG_MEMBER_ROLE_VALUES).default(ORG_MEMBER_ROLES.MEMBER),
  designation: z.string().optional(),
  phone: z.string().optional(),
  departmentId: z.string().optional(),
  branchId: z.string().optional(),
  sendInvite: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const listAuditSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  actorUserId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListAuditInput = z.infer<typeof listAuditSchema>;

export const changeInviteRoleSchema = z.object({
  role: z.enum(ORG_MEMBER_ROLE_VALUES),
});
export type ChangeInviteRoleInput = z.infer<typeof changeInviteRoleSchema>;

export const listInvitationsSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  includeAccepted: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  status: z.enum(["pending", "accepted", "expired", "revoked"]).optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListInvitationsInput = z.infer<typeof listInvitationsSchema>;
