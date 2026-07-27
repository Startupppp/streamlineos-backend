import { z } from "zod";

export const listWorkspaceMembersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
});

export type ListWorkspaceMembersInput = z.infer<typeof listWorkspaceMembersSchema>;

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["member", "admin"]).default("member"),
});

export type AddWorkspaceMemberInput = z.infer<typeof addWorkspaceMemberSchema>;
