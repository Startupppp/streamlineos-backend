import { z } from "zod";
import { incidentSeverityEnum, incidentStatusEnum, incidentFollowUpStatusEnum } from "../../../../db/schema";
import { idCursorSchema } from "../../../../common/pagination/cursor.schema";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const incidentSeveritySchema = z.enum(incidentSeverityEnum.enumValues);
export const incidentStatusSchema = z.enum(incidentStatusEnum.enumValues);
export const incidentFollowUpStatusSchema = z.enum(incidentFollowUpStatusEnum.enumValues);

export const listIncidentsQuerySchema = z.object({
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export const incidentChildrenQuerySchema = z.object({
  limit: pageSizeField(100),
  updatesCursor: idCursorSchema,
  decisionsCursor: idCursorSchema,
  followUpActionsCursor: idCursorSchema,
}).strict();

export const createIncidentSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  severity: incidentSeveritySchema.optional(),
  status: incidentStatusSchema.optional(),
  impact: z.string().optional(),
  ownerId: z.string().min(1).optional(),
  rootCause: z.string().optional(),
  customerComms: z.string().optional(),
  detectedAt: z.coerce.date().optional(),
  responseDueAt: z.coerce.date().optional(),
  resolutionDueAt: z.coerce.date().optional(),
  linkedTicketId: z.number().int().positive().optional(),
  releaseId: z.number().int().positive().optional(),
}).strict();

export const updateIncidentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  severity: incidentSeveritySchema.optional(),
  status: incidentStatusSchema.optional(),
  impact: z.string().nullish(),
  ownerId: z.string().min(1).nullish(),
  rootCause: z.string().nullish(),
  customerComms: z.string().nullish(),
  detectedAt: z.coerce.date().nullish(),
  responseDueAt: z.coerce.date().nullish(),
  resolutionDueAt: z.coerce.date().nullish(),
  linkedTicketId: z.number().int().positive().nullish(),
  releaseId: z.number().int().positive().nullish(),
  followUpWaiverReason: z.string().trim().min(1).max(1000).optional(),
}).strict();

export const UNRESOLVED_FOLLOW_UP_STATUSES = ["open", "in_progress"] as const;

export const addIncidentUpdateSchema = z.object({
  message: z.string().min(1),
  newStatus: incidentStatusSchema.optional(),
  followUpWaiverReason: z.string().trim().min(1).max(1000).optional(),
}).strict();

export const addIncidentDecisionSchema = z.object({
  decision: z.string().min(1).max(4000),
  rationale: z.string().max(4000).optional(),
}).strict();

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
  status: incidentFollowUpStatusSchema.optional(),
  dueAt: z.coerce.date().nullish(),
}).strict();

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
export type IncidentChildrenQuery = z.infer<typeof incidentChildrenQuerySchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
export type AddIncidentUpdateInput = z.infer<typeof addIncidentUpdateSchema>;
export type AddIncidentDecisionInput = z.infer<typeof addIncidentDecisionSchema>;
export type CreateFollowUpActionInput = z.infer<typeof createFollowUpActionSchema>;
export type UpdateFollowUpActionInput = z.infer<typeof updateFollowUpActionSchema>;
