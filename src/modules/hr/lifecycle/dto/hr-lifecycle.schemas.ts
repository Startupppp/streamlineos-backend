import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { TERMINATION_REASONS, TERMINATION_REASON_OTHER, RESIGNATION_REASONS } from "../hr-separation.constants";

const VALID_REASONS: readonly string[] = TERMINATION_REASONS;

const resignationFileReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      /^https:\/\//i.test(value) || /^resignations\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(value),
    "Must be a stored resignation file reference",
  );

export const resignationCreateSchema = z.object({
  reason: z.string().min(50, "Detailed reason must be at least 50 characters").max(2000),
  reasonCategory: z.enum(RESIGNATION_REASONS),
  lastWorkingDate: z.string().min(1, "Last working date is required"),
  noticePeriodDays: z.number().int().min(0).max(180).optional().default(30),
  willingForExitInterview: z.boolean().optional().default(true),
  companyFeedback: z.string().max(2000).optional(),
  resignationLetterUrl: resignationFileReferenceSchema.optional(),
}).strict();

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
}).strict();

export const resignationFinalReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  remarks: z.string().optional(),
}).strict();

export const resignationHrReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  remarks: z.string().optional(),
}).strict();

export const alumniListSchema = z.object({
  limit: pageSizeField(50),
}).strict();

export const alumniCreateSchema = z.object({
  userId: z.string().min(1, "Employee is required"),
  currentCompany: z.string().max(100).optional(),
  currentRole: z.string().max(100).optional(),
  linkedinUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  email: z.string().email("Must be a valid email").optional().or(z.literal("")),
  leftDate: z.string().optional(),
  isOptedIn: z.boolean().optional(),
}).strict();

export const experienceLetterSchema = z.object({
  userId: z.string().min(1),
  relievingDate: z.string().min(1),
}).strict();

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
  }).strict()
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
}).strict();

export const listTerminationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["DRAFT", "PENDING_FINAL", "APPROVED", "REJECTED", "SENT", "COMPLETED"]).optional(),
}).strict();

export const attendanceAnalyticsQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
}).strict();

export const listOnboardingDocsQuerySchema = z
  .object({
    userId: z.string().optional(),
    status: z.enum(["PENDING", "SUBMITTED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]).optional(),
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(20, 100),
  })
  .strict();

export const onboardingDocsSummaryQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(20, 100),
    status: z.enum(["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]).optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

const onboardingFileReferenceSchema = z
  .string()
  .trim()
  .min(1, "fileUrl is required")
  .max(2048, "fileUrl is too long")
  .refine(
    (value) =>
      /^https:\/\//i.test(value) || /^(?:onboarding|onboarding-docs)\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(value),
    "fileUrl must be a stored onboarding file reference",
  );

export const createOnboardingDocSchema = z.object({
  documentTypeId: z.number().int().positive("documentTypeId is required"),
  fileUrl: onboardingFileReferenceSchema,
  fileName: z.string().min(1, "fileName is required"),
  fileSize: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  targetUserId: z.string().optional(),
}).strict();

export const createOwnOnboardingDocSchema = createOnboardingDocSchema.omit({
  targetUserId: true,
}).strict();

export const reviewOnboardingDocSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]),
  remarks: z.string().optional(),
}).strict();

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
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  status: z
    .enum([
      "SUBMITTED", "PENDING_HR", "HR_APPROVED", "FINAL_APPROVED",
      "IN_PROGRESS", "APPROVED", "WITHDRAWN", "COMPLETED", "REJECTED",
    ])
    .optional(),
}).strict();

export type ListResignationsQueryInput = z.infer<typeof listResignationsQuerySchema>;
