import { z } from "zod";
import { portfolioHealthEnum, portfolioStatusEnum } from "../../../../db/schema";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listPortfoliosQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
}).strict();

export const createPortfolioSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  ownerId: z.string().min(1).optional(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).optional(),
  strategicGoal: z.string().optional(),
}).strict();

export const updatePortfolioSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).nullish(),
  strategicGoal: z.string().nullish(),
}).strict();

export const linkProjectSchema = z.object({
  projectId: z.number().int().positive(),
}).strict();

export const listProgramsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  q: z.string().trim().min(1).max(120).optional(),
  ownerId: z.string().trim().min(1).max(255).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).optional(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  portfolioId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  sort: z.enum(["createdAt", "updatedAt", "name"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
}).strict();

export const portfolioDetailQuerySchema = z.object({
  projectsCursor: z.string().optional(),
  projectsLimit: pageSizeField(20),
  programsCursor: z.string().optional(),
  programsLimit: pageSizeField(20),
}).strict();

export const programDetailQuerySchema = z.object({
  projectsCursor: z.string().optional(),
  projectsLimit: pageSizeField(20),
}).strict();

export const createProgramSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  portfolioId: z.number().int().positive().optional(),
  ownerId: z.string().min(1).optional(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).optional(),
}).strict();

export const updateProgramSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  portfolioId: z.number().int().positive().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).nullish(),
}).strict();

export type ListPortfoliosQuery = z.infer<typeof listPortfoliosQuerySchema>;
export type LinkedProjectsQuery = { cursor?: string; limit: number };
export type PortfolioDetailQuery = z.infer<typeof portfolioDetailQuerySchema>;
export type ProgramDetailQuery = z.infer<typeof programDetailQuerySchema>;
export type CreatePortfolioInput = z.infer<typeof createPortfolioSchema>;
export type UpdatePortfolioInput = z.infer<typeof updatePortfolioSchema>;
export type LinkProjectInput = z.infer<typeof linkProjectSchema>;
export type ListProgramsQuery = z.infer<typeof listProgramsQuerySchema>;
export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
