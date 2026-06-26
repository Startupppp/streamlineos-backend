import { z } from "zod";

const JOB_STATUSES = ["DRAFT", "OPEN", "PAUSED", "CLOSED", "FILLED"] as const;
const VALID_JOB_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACT",
  "INTERNSHIP",
  "FREELANCE",
  "TEMPORARY",
  "CONSULTANT",
  "APPRENTICESHIP",
  "COMMISSION_BASED",
] as const;
const MAX_SALARY = 999_999_999;

export const jobListSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type JobListInput = z.infer<typeof jobListSchema>;

export const createJobSchema = z
  .object({
    title: z
      .string()
      .min(2, "Job Title must be at least 2 characters")
      .max(100, "Job Title must be at most 100 characters")
      .refine((v) => /^[a-zA-Z]/.test(v.trim()), "Job Title must start with a letter")
      .refine((v) => !/[^a-zA-Z0-9\s\-',]/.test(v.trim()), "Job Title may only contain letters, numbers, hyphens, apostrophes, and commas")
      .refine((v) => !/(.)\1{3,}/.test(v.trim()), "Job Title cannot have 4 or more consecutive identical characters")
      .refine((v) => !/\s{2,}/.test(v), "Job Title cannot have multiple consecutive spaces"),
    departmentId: z.number().int().positive().optional(),
    hiringFlowId: z.number().int().positive().optional(),
    location: z
      .string()
      .min(2, "Location must be at least 2 characters")
      .max(100, "Location must be at most 100 characters")
      .refine((v) => !v || /^[a-zA-Z]/.test(v.trim()), "Location must start with a letter")
      .refine((v) => !v || !/[^a-zA-Z0-9\s\-',]/.test(v.trim()), "Location may only contain letters, numbers, hyphens, apostrophes, and commas")
      .refine((v) => !v || !/(.)\1{3,}/.test(v.trim()), "Location cannot have 4 or more consecutive identical characters")
      .refine((v) => !v || !/\s{2,}/.test(v), "Location cannot have multiple consecutive spaces")
      .optional(),
    type: z.enum(VALID_JOB_TYPES).optional(),
    experience: z.string().max(100).optional(),
    salaryMin: z.number().min(1, "Minimum salary must be greater than 0").max(MAX_SALARY, "Salary value is too large").optional(),
    salaryMax: z.number().min(1, "Maximum salary must be greater than 0").max(MAX_SALARY, "Salary value is too large").optional(),
    description: z.string().max(10000).optional(),
    requirements: z.string().max(5000).optional(),
    benefits: z.string().max(5000).optional(),
    openings: z.number().int().min(1).max(999).optional(),
    applicationDeadline: z
      .string()
      .refine((d) => !d || new Date(d) >= new Date(new Date().toDateString()), "Application deadline cannot be in the past")
      .optional(),
    status: z.enum(JOB_STATUSES).optional(),
  })
  .refine(
    (d) => {
      if (d.salaryMin !== undefined && d.salaryMax !== undefined) {
        return d.salaryMin <= d.salaryMax;
      }
      return true;
    },
    { message: "Minimum salary must be ≤ maximum salary", path: ["salaryMin"] },
  );
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = z
  .object({
    title: z.string().min(1).max(200),
    departmentId: z.number().int().positive(),
    hiringFlowId: z.number().int().positive().nullable(),
    location: z.string().max(200),
    type: z.string().max(50),
    experience: z.string().max(100),
    salaryMin: z.union([z.number(), z.string()]),
    salaryMax: z.union([z.number(), z.string()]),
    description: z.string().max(20_000),
    requirements: z.string().max(20_000),
    benefits: z.string().max(20_000),
    status: z.enum(JOB_STATUSES),
    openings: z.number().int().positive(),
    applicationDeadline: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
  })
  .partial();
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

export const publishJobSchema = z.object({
  platforms: z.array(z.enum(["LINKEDIN", "NAUKRI", "INDEED"])).min(1, "Select at least one platform"),
});
export type PublishJobInput = z.infer<typeof publishJobSchema>;

export const assignRecruiterSchema = z.object({ userId: z.string().min(1) });
export type AssignRecruiterInput = z.infer<typeof assignRecruiterSchema>;

export const internalApplySchema = z.object({
  coverLetter: z.string().max(5000).optional(),
  notes: z.string().max(2000).optional(),
});
export type InternalApplyInput = z.infer<typeof internalApplySchema>;

const SUPPORTED_PORTALS = ["LINKEDIN", "NAUKRI", "INDEED", "ORGANIC"] as const;

export const upsertPortalSchema = z.object({
  platform: z.enum(SUPPORTED_PORTALS),
  isActive: z.boolean().default(true),
  oauthToken: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type UpsertPortalInput = z.infer<typeof upsertPortalSchema>;

export const recruiterActivitySchema = z.object({
  action: z.enum(["CALL_MADE", "EMAIL_SENT", "CANDIDATE_ADDED", "NOTE_ADDED", "INTERVIEW_SCHEDULED"]),
  candidateId: z.number().int().positive().optional(),
  jobPostingId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
});
export type RecruiterActivityInput = z.infer<typeof recruiterActivitySchema>;

export const recruiterActivityQuerySchema = z.object({
  recruiterId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RecruiterActivityQueryInput = z.infer<typeof recruiterActivityQuerySchema>;
