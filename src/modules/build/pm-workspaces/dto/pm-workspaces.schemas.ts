import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listWorkspacesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  status: z.enum(["active", "archived"]).optional(),
}).strict();

export const listMembersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
}).strict();

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9-]*$/),
}).strict();

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict();

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["member", "admin"]).default("member"),
}).strict();

export type ListWorkspacesQuery = z.infer<typeof listWorkspacesQuerySchema>;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type AddWorkspaceMemberInput = z.infer<typeof addWorkspaceMemberSchema>;
