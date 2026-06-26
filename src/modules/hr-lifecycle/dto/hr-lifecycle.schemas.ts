import { z } from "zod";
import { TERMINATION_REASONS, TERMINATION_REASON_OTHER } from "../hr-separation.constants";

const VALID_REASONS: readonly string[] = TERMINATION_REASONS;

export const alumniListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
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

export const terminationLetterQuerySchema = z.object({
  format: z.string().optional(),
});

export const attendanceAnalyticsQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().optional(),
});

export type AlumniListInput = z.infer<typeof alumniListSchema>;
export type AlumniCreateInput = z.infer<typeof alumniCreateSchema>;
export type ExperienceLetterInput = z.infer<typeof experienceLetterSchema>;
export type TerminationCreateInput = z.infer<typeof terminationCreateSchema>;
export type TerminationReviewInput = z.infer<typeof terminationReviewSchema>;
export type TerminationLetterQuery = z.infer<typeof terminationLetterQuerySchema>;
export type AttendanceAnalyticsQuery = z.infer<typeof attendanceAnalyticsQuerySchema>;
