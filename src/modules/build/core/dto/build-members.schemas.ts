import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listBuildMembersSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  search: z.string().optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
}).strict();

export type ListBuildMembersInput = z.infer<typeof listBuildMembersSchema>;

export const addBuildMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["member", "admin"]).default("member"),
}).strict();

export type AddBuildMemberInput = z.infer<typeof addBuildMemberSchema>;
