import { z } from "zod";

export const listUsersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
  role: z.string().optional(),
  departmentId: z.coerce.number().int().optional(),
  branchId: z.coerce.number().int().optional(),
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
  departmentId: z.coerce.number().int().optional(),
  role: z.string().optional(),
  bio: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  twitterUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  reportingTo: z.string().optional(),
  team: z.string().optional(),
  emergencyContact: emergencyContactSchema,
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateUserStatusSchema = z.object({
  status: z.enum(["active", "suspended", "archived"]),
  reason: z.string().optional(),
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

export const inviteUserSchema = z.object({
  email: z.string().email(),
  role: z.string().default("ENGINEERING"),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const bulkInviteSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(50),
  role: z.string().default("ENGINEERING"),
});
export type BulkInviteInput = z.infer<typeof bulkInviteSchema>;

export const updatePreferencesSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  language: z.string().optional(),
  timezone: z.string().optional(),
  dateFormat: z.string().optional(),
  timeFormat: z.enum(["12h", "24h"]).optional(),
  notificationPreferences: z.record(z.string(), z.boolean()).optional(),
  dashboardPreferences: z.record(z.string(), z.unknown()).optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export const updateMembershipSchema = z.object({
  businessUnitId: z.string().optional().nullable(),
  branchId: z.number().int().optional().nullable(),
  departmentId: z.number().int().optional().nullable(),
  teamId: z.string().optional().nullable(),
  managerUserId: z.string().optional().nullable(),
  isPrimary: z.boolean().optional(),
});
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;

export const bulkActionSchema = z.object({
  userIds: z.array(z.string()).min(1).max(200),
  reason: z.string().optional(),
});
export type BulkActionInput = z.infer<typeof bulkActionSchema>;

export const listLoginHistorySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  success: z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true")),
});
export type ListLoginHistoryInput = z.infer<typeof listLoginHistorySchema>;

export const importUsersRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.string().default("MEMBER"),
  designation: z.string().optional(),
  phone: z.string().optional(),
});
export type ImportUsersRow = z.infer<typeof importUsersRowSchema>;

export const bulkUpdateUsersSchema = z.object({
  userIds: z.array(z.string()).min(1).max(200),
  role: z.string().optional(),
  departmentId: z.number().int().optional().nullable(),
  branchId: z.number().int().optional().nullable(),
  teamId: z.string().optional().nullable(),
  managerUserId: z.string().optional().nullable(),
});
export type BulkUpdateUsersInput = z.infer<typeof bulkUpdateUsersSchema>;

export const listAuditSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  actorUserId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListAuditInput = z.infer<typeof listAuditSchema>;
