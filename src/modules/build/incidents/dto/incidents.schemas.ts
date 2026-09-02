import { z } from "zod";
import { incidentSeverityEnum, incidentStatusEnum } from "../../../../db/schema";

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
}).strict();

export const addIncidentUpdateSchema = z.object({
  message: z.string().min(1),
  newStatus: z.enum(incidentStatusEnum.enumValues).optional(),
}).strict();

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
export type AddIncidentUpdateInput = z.infer<typeof addIncidentUpdateSchema>;
