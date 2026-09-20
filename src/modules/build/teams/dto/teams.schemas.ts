import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listTeamsQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: pageSizeField(50),
  search: z.string().optional(),
  pmWorkspaceId: z.string().optional(),
}).strict();

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
  pmWorkspaceId: z.string().optional(),
}).strict();

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  icon: z.string().nullish(),
  color: z.string().nullish(),
  isPrivate: z.boolean().optional(),
}).strict();

export const addTeamMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["member", "lead"]).optional(),
}).strict();

export const listTeamMembersQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: pageSizeField(50),
}).strict();

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(["member", "lead"]),
}).strict();

export const addTeamProjectSchema = z.object({
  projectId: z.number().int().positive(),
}).strict();

export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type ListTeamMembersQuery = z.infer<typeof listTeamMembersQuerySchema>;
export type UpdateTeamMemberRoleInput = z.infer<typeof updateTeamMemberRoleSchema>;
export type AddTeamProjectInput = z.infer<typeof addTeamProjectSchema>;
