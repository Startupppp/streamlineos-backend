import { z } from "zod";
import { portfolioHealthEnum, portfolioStatusEnum } from "../../../../db/schema";

export const listPortfoliosQuerySchema = z.object({
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
});

export const createPortfolioSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  ownerId: z.string().min(1).optional(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).optional(),
  strategicGoal: z.string().optional(),
});

export const updatePortfolioSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).nullish(),
  strategicGoal: z.string().nullish(),
});

export const linkProjectSchema = z.object({
  projectId: z.number().int().positive(),
});

export const listProgramsQuerySchema = z.object({
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  portfolioId: z.coerce.number().int().positive().optional(),
});

export const createProgramSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  portfolioId: z.number().int().positive().optional(),
  ownerId: z.string().min(1).optional(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).optional(),
});

export const updateProgramSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  portfolioId: z.number().int().positive().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(portfolioStatusEnum.enumValues).optional(),
  health: z.enum(portfolioHealthEnum.enumValues).nullish(),
});

export type ListPortfoliosQuery = z.infer<typeof listPortfoliosQuerySchema>;
export type CreatePortfolioInput = z.infer<typeof createPortfolioSchema>;
export type UpdatePortfolioInput = z.infer<typeof updatePortfolioSchema>;
export type LinkProjectInput = z.infer<typeof linkProjectSchema>;
export type ListProgramsQuery = z.infer<typeof listProgramsQuerySchema>;
export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
