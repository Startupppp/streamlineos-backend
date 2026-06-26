import { z } from "zod";

const NAME_REGEX = /[a-zA-Z]/;
const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;

const CANDIDATE_STATUSES = ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;
const CANDIDATE_SOURCES = [
  "LINKEDIN",
  "NAUKRI",
  "INDEED",
  "REFERRAL",
  "CAREERS_PAGE",
  "DIRECT",
  "JOB_PORTAL",
  "CAMPUS",
] as const;

export const candidateListSchema = z.object({
  status: z.enum(CANDIDATE_STATUSES).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});
export type CandidateListInput = z.infer<typeof candidateListSchema>;

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
});
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
});
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;

export const stageSchema = z.object({
  stage: z.enum(CANDIDATE_STATUSES),
});
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
});
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
});
export type ImportInput = z.infer<typeof importSchema>;

export const bulkRejectSchema = z.object({
  candidateIds: z
    .array(z.number().int().positive())
    .min(1, "Provide at least one candidate ID")
    .max(100, "Cannot reject more than 100 candidates at once"),
  sendRejectionEmail: z.boolean().default(true),
});
export type BulkRejectInput = z.infer<typeof bulkRejectSchema>;

const SLA_STATUSES = ["ON_TRACK", "AT_RISK", "BREACHED"] as const;

export const slaResetSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(SLA_STATUSES).optional().default("ON_TRACK"),
});
export type SlaResetInput = z.infer<typeof slaResetSchema>;

export const createApplicationSchema = z.object({
  jobPostingId: z.number(),
  coverLetter: z.string().optional(),
});
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const bgvStatusSchema = z.object({
  bgvStatus: z.enum(["NOT_INITIATED", "INITIATED", "PENDING", "CLEARED", "FAILED"]),
  bgvAgency: z.string().max(200).optional(),
  bgvNotes: z.string().max(2000).optional(),
});
export type BgvStatusInput = z.infer<typeof bgvStatusSchema>;

export const diversityReportQuerySchema = z.object({
  jobId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  departmentIds: z.string().optional(),
});
export type DiversityReportQueryInput = z.infer<typeof diversityReportQuerySchema>;
