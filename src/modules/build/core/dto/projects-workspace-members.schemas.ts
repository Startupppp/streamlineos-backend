import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listWorkspaceMembersSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  search: z.string().optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
}).strict();

export type ListWorkspaceMembersInput = z.infer<typeof listWorkspaceMembersSchema>;

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["member", "admin"]).default("member"),
}).strict();

export type AddWorkspaceMemberInput = z.infer<typeof addWorkspaceMemberSchema>;
