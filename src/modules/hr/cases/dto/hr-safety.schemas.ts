import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createIncidentSchema = z.object({
  type: z.enum(["injury", "accident", "near_miss", "hazard", "environmental", "other"]),
  location: z.string().min(1).max(500),
  occurredAt: z.string().min(1),
  description: z.string().min(10).max(10000),
  severity: z.enum(["low", "medium", "high", "critical"]),
  medicalAttention: z.boolean().optional(),
  confidentialMedicalNote: z.string().max(10000).optional(),
}).strict();

export const updateIncidentSchema = z.object({
  status: z.enum(["open", "investigating", "mitigated", "closed"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  description: z.string().min(10).max(10000).optional(),
  confidentialMedicalNote: z.string().max(10000).nullable().optional(),
  medicalAttention: z.boolean().optional(),
}).strict();

export const listIncidentsSchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["open", "investigating", "mitigated", "closed"]).optional(),
  type: z.enum(["injury", "accident", "near_miss", "hazard", "environmental", "other"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
}).strict();

export const checkinSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  score: z.number().int().min(1).max(10),
  flags: z.array(z.string()).max(10).optional(),
}).strict();

export const wellnessTrendSchema = z.object({
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
}).strict();

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
export type ListIncidentsInput = z.infer<typeof listIncidentsSchema>;
export type CheckinInput = z.infer<typeof checkinSchema>;
export type WellnessTrendInput = z.infer<typeof wellnessTrendSchema>;
