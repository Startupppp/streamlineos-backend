import { z } from "zod";
import { incidentSeverityEnum, incidentStatusEnum, incidentFollowUpStatusEnum } from "../../../../db/schema";

export const listIncidentsQuerySchema = z.object({
  status: z.enum(incidentStatusEnum.enumValues).optional(),
  severity: z.enum(incidentSeverityEnum.enumValues).optional(),
}).strict();

export const createIncidentSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  severity: z.enum(incidentSeverityEnum.enumValues).optional(),
  status: z.enum(incidentStatusEnum.enumValues).optional(),
  impact: z.string().optional(),
  ownerId: z.string().min(1).optional(),
  rootCause: z.string().optional(),
  customerComms: z.string().optional(),
  detectedAt: z.coerce.date().optional(),
  responseDueAt: z.coerce.date().optional(),
  resolutionDueAt: z.coerce.date().optional(),
  linkedTicketId: z.number().int().positive().optional(),
  // Postmortem field: the release this incident affected. See db/schema/build/incidents.ts
  // for why `releaseId` (not a "service" reference) is the canonical link this schema offers.
  releaseId: z.number().int().positive().optional(),
}).strict();

export const updateIncidentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  severity: z.enum(incidentSeverityEnum.enumValues).optional(),
  status: z.enum(incidentStatusEnum.enumValues).optional(),
  impact: z.string().nullish(),
  ownerId: z.string().min(1).nullish(),
  rootCause: z.string().nullish(),
  customerComms: z.string().nullish(),
  detectedAt: z.coerce.date().nullish(),
  responseDueAt: z.coerce.date().nullish(),
  resolutionDueAt: z.coerce.date().nullish(),
  linkedTicketId: z.number().int().positive().nullish(),
  releaseId: z.number().int().positive().nullish(),
}).strict();

export const addIncidentUpdateSchema = z.object({
  message: z.string().min(1),
  newStatus: z.enum(incidentStatusEnum.enumValues).optional(),
}).strict();

// Postmortem field: decisions — an append-only log (see incident_decisions).
export const addIncidentDecisionSchema = z.object({
  decision: z.string().min(1).max(4000),
  rationale: z.string().max(4000).optional(),
}).strict();

// Postmortem field: follow-up actions — each with its own owner/status/due-date lifecycle.
export const createFollowUpActionSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(4000).optional(),
  ownerId: z.string().min(1).optional(),
  dueAt: z.coerce.date().optional(),
}).strict();

export const updateFollowUpActionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(4000).nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(incidentFollowUpStatusEnum.enumValues).optional(),
  dueAt: z.coerce.date().nullish(),
}).strict();

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
export type AddIncidentUpdateInput = z.infer<typeof addIncidentUpdateSchema>;
export type AddIncidentDecisionInput = z.infer<typeof addIncidentDecisionSchema>;
export type CreateFollowUpActionInput = z.infer<typeof createFollowUpActionSchema>;
export type UpdateFollowUpActionInput = z.infer<typeof updateFollowUpActionSchema>;
