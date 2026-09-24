import { z } from "zod";
import { optionalPageSizeField } from "../../../../common/pagination/list-query.schema";
import {
  REJECTION_NOTE_MAX_LENGTH,
  REJECTION_REASONS,
} from "../disposition/rejection-reasons";

const NAME_REGEX = /[a-zA-Z]/;
const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;

const CANDIDATE_STATUSES = ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;
/**
 * `INTERNAL` was written by the internal-mobility apply path and was missing
 * from this list, so every internally applied candidate carried a source the
 * filter could not select and neither intake sheet could set — invisible on the
 * one screen that would show an internal pipeline.
 */
const CANDIDATE_SOURCES = [
  "LINKEDIN",
  "NAUKRI",
  "INDEED",
  "REFERRAL",
  "CAREERS_PAGE",
  "DIRECT",
  "JOB_PORTAL",
  "CAMPUS",
  "INTERNAL",
] as const;

/**
 * The disposition half of a reject, optional at the edge and decided in the
 * service.
 *
 * Optional here on purpose. Whether a reason is needed depends on the stage
 * being moved to, and a `superRefine` restating that would put the rule in two
 * places — which is how one copy learns a new code and the other keeps refusing
 * it. The edge checks shape and bounds; `decideRejection` is the only thing
 * that decides whether a rejection may be recorded.
 */
const rejectionFields = {
  rejectionReason: z.enum(REJECTION_REASONS).optional(),
  rejectionNote: z.string().trim().max(REJECTION_NOTE_MAX_LENGTH).optional(),
};

export const candidateListSchema = z
  .object({
    status: z.enum(CANDIDATE_STATUSES).optional(),
    source: z.string().optional(),
    jobId: z.coerce.number().int().positive().optional(),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().optional(),
    limit: optionalPageSizeField(),
  }).strict()
  .transform((q) => ({
    status: q.status,
    source: q.source,
    jobId: q.jobId,
    search: q.search || undefined,
    cursor: q.cursor,
    limit: q.limit ?? 20,
  }));
export type CandidateListInput = z.output<typeof candidateListSchema>;

export const createCandidateSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(50, "First name must be at most 50 characters")
    .regex(NAME_REGEX, "First name must contain at least one letter"),
  lastName: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(50, "Last name must be at most 50 characters")
    .regex(NAME_REGEX, "Last name must contain at least one letter"),
  email: z.string().trim().email("Valid email is required").max(254, "Email must be at most 254 characters"),
  phone: z.string().regex(PHONE_REGEX, "Phone must be 8-15 digits, optionally starting with +").optional().or(z.literal("")),
  resumeUrl: z.string().url().optional().or(z.literal("")),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  portfolioUrl: z.string().url().optional().or(z.literal("")),
  currentCompany: z.string().optional(),
  currentRole: z.string().optional(),
  experienceYears: z.number().min(0).max(50).optional(),
  skills: z.array(z.string()).optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
}).strict();
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;

export const updateCandidateSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal("")),
  portfolioUrl: z.string().url().max(500).optional().or(z.literal("")),
  currentCompany: z.string().max(200).optional(),
  currentRole: z.string().max(200).optional(),
  experienceYears: z.number().min(0, "Cannot be negative").max(50, "Cannot exceed 50 years").optional(),
  skills: z.array(z.string()).optional(),
  source: z.enum(CANDIDATE_SOURCES).optional(),
  status: z.enum(CANDIDATE_STATUSES).optional(),
  notes: z.string().max(5000).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  resumeUrl: z.string().url().max(500).optional().or(z.literal("")),
  ...rejectionFields,
}).strict();
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;

export const stageSchema = z.object({
  stage: z.enum(CANDIDATE_STATUSES),
  ...rejectionFields,
}).strict();
export type StageInput = z.infer<typeof stageSchema>;

const bulkImportRowSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(200),
  phone: z.string().max(50).optional().nullable(),
  currentCompany: z.string().max(200).optional().nullable(),
  currentRole: z.string().max(200).optional().nullable(),
  resumeUrl: z.string().url().max(500).optional().nullable(),
  linkedinUrl: z.string().url().max(500).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  skills: z.string().max(1000).optional().nullable(),
  experienceYears: z.number().min(0).max(60).optional().nullable(),
  source: z.string().max(100).optional().nullable(),
});

export const bulkImportSchema = z.object({
  rows: z.array(bulkImportRowSchema).min(1).max(500),
}).strict();
export type BulkImportInput = z.infer<typeof bulkImportSchema>;

const importRowSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  currentCompany: z.string().optional(),
  currentRole: z.string().optional(),
  source: z.string().optional(),
  skills: z.string().optional(),
});

export const importSchema = z.object({
  candidates: z.array(importRowSchema).min(1, "At least one candidate required").max(500),
}).strict();
export type ImportInput = z.infer<typeof importSchema>;

export const bulkRejectSchema = z.object({
  candidateIds: z
    .array(z.number().int().positive())
    .min(1, "Provide at least one candidate ID")
    .max(100, "Cannot reject more than 100 candidates at once"),
  sendRejectionEmail: z.boolean().default(true),
}).strict();
export type BulkRejectInput = z.infer<typeof bulkRejectSchema>;

export const bulkShortlistSchema = z.object({
  candidateIds: z
    .array(z.number().int().positive())
    .min(1, "Provide at least one candidate ID")
    .max(100, "Cannot shortlist more than 100 candidates at once"),
}).strict();
export type BulkShortlistInput = z.infer<typeof bulkShortlistSchema>;

export const linkDuplicateSchema = z.object({
  duplicateOfId: z.number().int().positive(),
}).strict();
export type LinkDuplicateInput = z.infer<typeof linkDuplicateSchema>;

const SLA_STATUSES = ["ON_TRACK", "AT_RISK", "BREACHED"] as const;

export const slaResetSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(SLA_STATUSES).optional().default("ON_TRACK"),
}).strict();
export type SlaResetInput = z.infer<typeof slaResetSchema>;

export const createApplicationSchema = z.object({
  jobPostingId: z.number(),
  coverLetter: z.string().optional(),
}).strict();
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const bgvStatusSchema = z.object({
  bgvStatus: z.enum(["NOT_INITIATED", "INITIATED", "PENDING", "CLEARED", "FAILED"]),
  bgvAgency: z.string().max(200).optional(),
  bgvNotes: z.string().max(2000).optional(),
}).strict();
export type BgvStatusInput = z.infer<typeof bgvStatusSchema>;

export const diversityReportQuerySchema = z.object({
  jobId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  departmentIds: z.string().optional(),
}).strict();
export type DiversityReportQueryInput = z.infer<typeof diversityReportQuerySchema>;
