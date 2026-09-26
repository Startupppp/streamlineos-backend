import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createGitConnectionSchema = z.object({
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  repoUrl: z.string().url().max(500),
  repoName: z.string().max(200).optional(),
  projectId: z.number().int().positive().nullable().optional(),
}).strict();

export const updateGitConnectionSchema = z.object({
  isActive: z.boolean().optional(),
  repoUrl: z.string().url().max(500).optional(),
  repoName: z.string().max(200).nullable().optional(),
  projectId: z.number().int().positive().nullable().optional(),
}).strict();

export const gitConnectionsListSchema = z.object({
  limit: pageSizeField(50),
  cursor: z.string().optional(),
  search: z.string().optional(),
}).strict();

export type CreateGitConnectionInput = z.infer<typeof createGitConnectionSchema>;
export type UpdateGitConnectionInput = z.infer<typeof updateGitConnectionSchema>;
export type GitConnectionsListInput = z.infer<typeof gitConnectionsListSchema>;
