import { z } from "zod";

export const listGroupsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const createGroupSchema = z
  .object({
    name: z.string().min(1).max(100).trim(),
  })
  .strict();

export const renameGroupSchema = z
  .object({
    name: z.string().min(1).max(100).trim(),
  })
  .strict();

export const addGroupMemberSchema = z
  .object({
    membershipId: z.number().int().positive(),
  })
  .strict();

export const assignGroupRoleSchema = z
  .object({
    roleId: z.number().int().positive(),
  })
  .strict();

export type ListGroupsQuery = z.infer<typeof listGroupsQuerySchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type RenameGroupInput = z.infer<typeof renameGroupSchema>;
export type AddGroupMemberInput = z.infer<typeof addGroupMemberSchema>;
export type AssignGroupRoleInput = z.infer<typeof assignGroupRoleSchema>;
