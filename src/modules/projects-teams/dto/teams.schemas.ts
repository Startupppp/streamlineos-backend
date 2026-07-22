import { z } from "zod";

export const listTeamsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  search: z.string().optional(),
});

export const createTeamSchema = z.object({
  name: z.string().min(1).max(255),
  key: z
    .string()
    .min(1)
    .max(10)
    .toUpperCase()
    .regex(/^[A-Z0-9]+$/, "Key must be alphanumeric uppercase"),
  icon: z.string().optional(),
  color: z.string().optional(),
  isPrivate: z.boolean().optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  icon: z.string().nullish(),
  color: z.string().nullish(),
  isPrivate: z.boolean().optional(),
});

export const addTeamMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["member", "lead"]).optional(),
});

export const listTeamMembersQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(["member", "lead"]),
});

export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type ListTeamMembersQuery = z.infer<typeof listTeamMembersQuerySchema>;
export type UpdateTeamMemberRoleInput = z.infer<typeof updateTeamMemberRoleSchema>;
