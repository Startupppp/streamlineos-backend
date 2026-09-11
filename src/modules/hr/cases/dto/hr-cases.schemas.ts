import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createCaseSchema = z.object({
  category: z.enum([
    "grievance", "disciplinary", "harassment", "ethics",
    "performance", "workplace_conflict", "policy_violation", "other",
  ]),
  subjectEmployeeId: z.string().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(5).max(300),
  details: z.string().min(10).max(10000),
  assignedTo: z.string().optional(),
  confidential: z.boolean().optional(),
}).strict();

export const anonymousReportSchema = z.object({
  category: z.enum(["grievance", "harassment", "ethics", "workplace_conflict", "policy_violation", "other"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(5).max(300),
  details: z.string().min(10).max(10000),
}).strict();

export const updateCaseSchema = z.object({
  status: z.enum(["open", "under_investigation", "resolved", "closed", "dismissed"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  assignedTo: z.string().nullable().optional(),
  outcome: z.string().max(5000).optional(),
  summary: z.string().min(5).max(300).optional(),
  details: z.string().min(10).max(10000).optional(),
  confidential: z.boolean().optional(),
}).strict();

export const listCasesSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["open", "under_investigation", "resolved", "closed", "dismissed"]).optional(),
  category: z.enum([
    "grievance", "disciplinary", "harassment", "ethics",
    "performance", "workplace_conflict", "policy_violation", "other",
  ]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  search: z.string().max(200).optional(),
  assignedTo: z.string().optional(),
}).strict();

export const createNoteSchema = z.object({
  note: z.string().min(1).max(10000),
  isConfidential: z.boolean().optional(),
}).strict();

export const addDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  restricted: z.boolean().optional(),
}).strict();

export const createDisciplinaryActionSchema = z.object({
  caseId: z.number().int().positive().optional(),
  employeeId: z.string().min(1),
  actionType: z.enum([
    "verbal_warning", "written_warning", "final_warning",
    "suspension", "termination_recommended",
  ]),
  effectiveDate: z.string().min(1),
  note: z.string().max(5000).optional(),
  generateLetter: z.boolean().optional(),
  letterTemplateId: z.number().int().positive().optional(),
  letterContext: z.record(z.string(), z.string()).optional(),
  /** Skip progressive ladder check (audited). */
  forceEscalate: z.boolean().optional(),
}).strict();

export const acknowledgeDisciplinarySchema = z.object({
  note: z.string().max(1000).optional(),
}).strict();
export type AcknowledgeDisciplinaryInput = z.infer<typeof acknowledgeDisciplinarySchema>;

export const listDisciplinarySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  employeeId: z.string().optional(),
  actionType: z.enum([
    "verbal_warning", "written_warning", "final_warning",
    "suspension", "termination_recommended",
  ]).optional(),
}).strict();

export type CreateCaseInput = z.infer<typeof createCaseSchema>;
export type AnonymousReportInput = z.infer<typeof anonymousReportSchema>;
export type UpdateCaseInput = z.infer<typeof updateCaseSchema>;
export type ListCasesInput = z.infer<typeof listCasesSchema>;
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type AddDocumentInput = z.infer<typeof addDocumentSchema>;
export type CreateDisciplinaryActionInput = z.infer<typeof createDisciplinaryActionSchema>;
export type ListDisciplinaryInput = z.infer<typeof listDisciplinarySchema>;
