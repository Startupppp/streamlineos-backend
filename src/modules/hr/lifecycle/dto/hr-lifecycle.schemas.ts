import { z } from "zod";
import { TERMINATION_REASONS, TERMINATION_REASON_OTHER, RESIGNATION_REASONS } from "../hr-separation.constants";

const VALID_REASONS: readonly string[] = TERMINATION_REASONS;

export const resignationCreateSchema = z.object({
  reason: z.string().min(50, "Detailed reason must be at least 50 characters").max(2000),
  reasonCategory: z.enum(RESIGNATION_REASONS),
  lastWorkingDate: z.string().min(1, "Last working date is required"),
  noticePeriodDays: z.number().int().min(0).max(180).optional().default(30),
  willingForExitInterview: z.boolean().optional().default(true),
  companyFeedback: z.string().max(2000).optional(),
  resignationLetterUrl: z.string().url("Must be a valid URL").optional(),
});

export const resignationUpdateSchema = z.object({
  status: z
    .enum([
      "SUBMITTED", "PENDING_HR", "HR_APPROVED", "FINAL_APPROVED",
      "IN_PROGRESS", "APPROVED", "WITHDRAWN", "COMPLETED", "REJECTED",
    ])
    .optional(),
  remarks: z.string().max(2000).optional(),
  exitInterviewNotes: z.string().max(5000).optional(),
  exitInterviewDate: z.string().optional(),
  feedback: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  checklistItems: z.array(z.string().min(1)).optional(),
  overrideAssetGate: z.boolean().optional(),
  overrideReason: z.string().min(1).max(1000).optional(),
});

export const resignationFinalReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  remarks: z.string().optional(),
});

export const resignationHrReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  remarks: z.string().optional(),
});

export const alumniListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const alumniCreateSchema = z.object({
  userId: z.string().min(1, "Employee is required"),
  currentCompany: z.string().max(100).optional(),
  currentRole: z.string().max(100).optional(),
  linkedinUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  email: z.string().email("Must be a valid email").optional().or(z.literal("")),
  leftDate: z.string().optional(),
  isOptedIn: z.boolean().optional(),
});

export const experienceLetterSchema = z.object({
  userId: z.string().min(1),
  relievingDate: z.string().min(1),
});

export const terminationCreateSchema = z
  .object({
    userId: z.string().min(1, "Employee is required"),
    reasons: z
      .array(z.string().min(1))
      .min(1, "A termination reason is required")
      .max(1, "Only one reason may be selected"),
    detailedExplanation: z.string().optional().default(""),
    effectiveDate: z.string().min(1, "Effective date is required"),
    severanceAmount: z.number().nonnegative().max(9999999).multipleOf(0.01).optional(),
    noticePeriodWaived: z.boolean().optional().default(false),
    internalNotes: z.string().max(1000).optional(),
  })
  .refine((data) => {
    const reason = data.reasons[0];
    return !reason || VALID_REASONS.includes(reason);
  }, { message: "Invalid termination reason", path: ["reasons"] })
  .refine((data) => {
    const reason = data.reasons[0];
    if (reason !== TERMINATION_REASON_OTHER) return true;
    return (data.detailedExplanation ?? "").trim().length >= 10;
  }, { message: "Remarks for 'Other' reason must be at least 10 characters", path: ["detailedExplanation"] })
  .refine((data) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const effective = new Date(data.effectiveDate);
    effective.setHours(0, 0, 0, 0);
    return effective >= today;
  }, { message: "Effective date must be today or a future date", path: ["effectiveDate"] });

export const terminationReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  remarks: z.string().optional(),
});

export const listTerminationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["DRAFT", "PENDING_FINAL", "APPROVED", "REJECTED", "SENT", "COMPLETED"]).optional(),
});

export const attendanceAnalyticsQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
});

export const listOnboardingDocsQuerySchema = z.object({
  userId: z.string().optional(),
  status: z.enum(["PENDING", "SUBMITTED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const onboardingDocsSummaryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]).optional(),
  search: z.string().max(200).optional(),
});

export const createOnboardingDocSchema = z.object({
  documentTypeId: z.number().int().positive("documentTypeId is required"),
  fileUrl: z.string().url("fileUrl must be a valid URL"),
  fileName: z.string().min(1, "fileName is required"),
  fileSize: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  targetUserId: z.string().optional(),
});

export const createOwnOnboardingDocSchema = createOnboardingDocSchema.omit({
  targetUserId: true,
});

export const reviewOnboardingDocSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]),
  remarks: z.string().optional(),
});

export type ListOnboardingDocsQueryInput = z.infer<typeof listOnboardingDocsQuerySchema>;
export type OnboardingDocsSummaryQueryInput = z.infer<typeof onboardingDocsSummaryQuerySchema>;
export type CreateOnboardingDocInput = z.infer<typeof createOnboardingDocSchema>;
export type CreateOwnOnboardingDocInput = z.infer<
  typeof createOwnOnboardingDocSchema
>;
export type ReviewOnboardingDocInput = z.infer<typeof reviewOnboardingDocSchema>;

export type ResignationCreateInput = z.infer<typeof resignationCreateSchema>;
export type ResignationUpdateInput = z.infer<typeof resignationUpdateSchema>;
export type ResignationFinalReviewInput = z.infer<typeof resignationFinalReviewSchema>;
export type ResignationHrReviewInput = z.infer<typeof resignationHrReviewSchema>;
export type AlumniListInput = z.infer<typeof alumniListSchema>;
export type AlumniCreateInput = z.infer<typeof alumniCreateSchema>;
export type ExperienceLetterInput = z.infer<typeof experienceLetterSchema>;
export type TerminationCreateInput = z.infer<typeof terminationCreateSchema>;
export type TerminationReviewInput = z.infer<typeof terminationReviewSchema>;
export type ListTerminationsQueryInput = z.infer<typeof listTerminationsQuerySchema>;
export type AttendanceAnalyticsQuery = z.infer<typeof attendanceAnalyticsQuerySchema>;

export const listResignationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      "SUBMITTED", "PENDING_HR", "HR_APPROVED", "FINAL_APPROVED",
      "IN_PROGRESS", "APPROVED", "WITHDRAWN", "COMPLETED", "REJECTED",
    ])
    .optional(),
});

export type ListResignationsQueryInput = z.infer<typeof listResignationsQuerySchema>;
