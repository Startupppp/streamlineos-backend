import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listWorkspaceMembersSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20),
  search: z.string().optional(),
  status: z.enum(["active", "suspended", "archived"]).optional(),
});

export type ListWorkspaceMembersInput = z.infer<typeof listWorkspaceMembersSchema>;

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["member", "admin"]).default("member"),
});

export type AddWorkspaceMemberInput = z.infer<typeof addWorkspaceMemberSchema>;
