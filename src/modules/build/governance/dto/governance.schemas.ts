import { z } from "zod";
import {
  riskProbabilityEnum,
  riskImpactEnum,
  riskStatusEnum,
  decisionStatusEnum,
} from "../../../../db/schema";
import { idCursorSchema } from "../../../../common/pagination/cursor.schema";

export const createRiskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  probability: z.enum(riskProbabilityEnum.enumValues).optional(),
  impact: z.enum(riskImpactEnum.enumValues).optional(),
  status: z.enum(riskStatusEnum.enumValues).optional(),
  ownerId: z.string().min(1).optional(),
  mitigation: z.string().optional(),
  linkedTicketId: z.number().int().positive().optional(),
}).strict();

export const updateRiskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  probability: z.enum(riskProbabilityEnum.enumValues).optional(),
  impact: z.enum(riskImpactEnum.enumValues).optional(),
  status: z.enum(riskStatusEnum.enumValues).optional(),
  ownerId: z.string().min(1).nullish(),
  mitigation: z.string().nullish(),
  linkedTicketId: z.number().int().positive().nullish(),
}).strict();

export const listRisksQuerySchema = z.object({
  status: z.enum(riskStatusEnum.enumValues).optional(),
  probability: z.enum(riskProbabilityEnum.enumValues).optional(),
  impact: z.enum(riskImpactEnum.enumValues).optional(),
  ownerId: z.string().min(1).optional(),
  cursor: idCursorSchema,
  search: z.string().max(200).optional(),
}).strict();

export const createDecisionSchema = z.object({
  title: z.string().min(1).max(500),
  context: z.string().optional(),
  decision: z.string().optional(),
  optionsConsidered: z.string().optional(),
  status: z.enum(decisionStatusEnum.enumValues).optional(),
  ownerId: z.string().min(1).optional(),
  decidedAt: z.coerce.date().optional(),
  revisitAt: z.coerce.date().optional(),
  linkedTicketId: z.number().int().positive().optional(),
}).strict();

export const updateDecisionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  context: z.string().nullish(),
  decision: z.string().nullish(),
  optionsConsidered: z.string().nullish(),
  status: z.enum(decisionStatusEnum.enumValues).optional(),
  ownerId: z.string().min(1).nullish(),
  decidedAt: z.coerce.date().nullish(),
  revisitAt: z.coerce.date().nullish(),
  linkedTicketId: z.number().int().positive().nullish(),
}).strict();

export const listDecisionsQuerySchema = z.object({
  status: z.enum(decisionStatusEnum.enumValues).optional(),
  ownerId: z.string().min(1).optional(),
  cursor: idCursorSchema,
  search: z.string().max(200).optional(),
}).strict();

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;
export type ListRisksQuery = z.infer<typeof listRisksQuerySchema>;
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
export type UpdateDecisionInput = z.infer<typeof updateDecisionSchema>;
export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;
