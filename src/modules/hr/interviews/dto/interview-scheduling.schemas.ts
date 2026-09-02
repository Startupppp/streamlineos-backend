import { z } from "zod";

const interviewTypeEnum = z.enum(["PHONE", "VIDEO", "ONSITE", "TECHNICAL", "HR", "FINAL"]);
const interviewResultEnum = z.enum(["PENDING", "PASSED", "FAILED", "NO_SHOW"]);

export const createInterviewSchema = z.object({
  candidateId: z.number().int().positive(),
  jobPostingId: z.number().int().positive().optional(),
  interviewerId: z.string().optional(),
  type: z.string().optional(),
  scheduledAt: z.string(),
  duration: z.number().int().positive().optional(),
  location: z.string().optional(),
  meetingLink: z.string().optional(),
  notes: z.string().optional(),
}).strict();
export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;

export const scheduleInterviewSchema = z
  .object({
    candidateId: z.number().int().positive(),
    jobPostingId: z.number().int().positive().optional(),
    scheduledAt: z.string().datetime(),
    durationMinutes: z.number().int().min(15).max(480).default(60),
    format: z.enum(["VIDEO", "PHONE", "IN_PERSON"]).default("VIDEO"),
    interviewers: z.array(z.string()).min(1),
    meetLink: z.string().url("Meet link must be a valid URL").optional(),
    notes: z.string().max(2000).optional(),
    createMeet: z.boolean().default(false),
    notifyChannels: z
      .object({
        email: z.boolean().default(true),
        whatsapp: z.boolean().default(false),
      })
      .default({ email: true, whatsapp: false }),
  })
  .refine((d) => d.format !== "VIDEO" || (!!d.meetLink && d.meetLink.trim().length > 0), {
    message: "Meet link is required for video interviews.",
    path: ["meetLink"],
  });
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewSchema>;

const slotSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
}).strict();

export const selfScheduleSchema = z.object({
  candidateId: z.number().int().positive(),
  jobPostingId: z.number().int().positive().optional(),
  interviewerIds: z.array(z.string()).min(1).max(20),
  durationMinutes: z.number().int().min(15).max(180).default(60),
  interviewType: z.enum(["VIDEO", "PHONE", "IN_PERSON"]).default("VIDEO"),
  availableSlots: z.array(slotSchema).min(1, "At least one available slot is required"),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  notes: z.string().max(2000).optional(),
}).strict();
export type SelfScheduleInput = z.infer<typeof selfScheduleSchema>;

export const updateInterviewSchema = z.object({
  type: interviewTypeEnum.optional(),
  scheduledAt: z.string().datetime().optional(),
  duration: z.number().int().positive().optional(),
  location: z.string().optional(),
  meetingLink: z.string().url().optional().or(z.literal("")),
  result: interviewResultEnum.optional(),
  feedback: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  rubric: z
    .array(
      z.object({
        category: z.string(),
        score: z.number(),
        maxScore: z.number(),
        comment: z.string().optional(),
      }),
    )
    .optional(),
  notes: z.string().optional(),
  recordingUrl: z.string().url().optional().or(z.literal("")).or(z.null()),
  recordingPlatform: z.string().max(50).optional().or(z.null()),
}).strict();
export type UpdateInterviewInput = z.infer<typeof updateInterviewSchema>;

export const submitScorecardSchema = z.object({
  ratings: z.record(z.string(), z.number().min(0).max(10)),
  recommendation: z.enum(["HIRE", "NO_HIRE", "MAYBE"]),
  notes: z.string().optional(),
  templateId: z.number().int().positive().optional(),
  isBlindMode: z.boolean().optional(),
}).strict();
export type SubmitScorecardInput = z.infer<typeof submitScorecardSchema>;

export const bookInterviewSchema = z.object({
  slotStart: z.string().datetime(),
}).strict();
export type BookInterviewInput = z.infer<typeof bookInterviewSchema>;
