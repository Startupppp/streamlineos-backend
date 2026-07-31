import { z } from "zod";

export const resumeParseBodySchema = z.object({
  resumeText: z.string().min(1, "resumeText is required"),
});
export type ResumeParseBodyInput = z.infer<typeof resumeParseBodySchema>;

export const ParsedResumeSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  currentCompany: z.string().nullable(),
  currentRole: z.string().nullable(),
  experienceYears: z.number().nullable(),
  skills: z.array(z.string()),
  location: z.string().nullable(),
  education: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  portfolioUrl: z.string().nullable(),
});
export type ParsedResume = z.infer<typeof ParsedResumeSchema>;

export const AiScoreSchema = z.object({
  overall: z.number(),
  breakdown: z.object({
    technicalSkills: z.number(),
    experience: z.number(),
    communication: z.number(),
    cultureFit: z.number(),
    leadership: z.number(),
  }),
  summary: z.string(),
});
export type AiScoreResult = z.infer<typeof AiScoreSchema>;

export const CompositeScoreSchema = z.object({
  verdict: z.enum(["STRONG_HIRE", "HIRE", "ON_FENCE", "NO_HIRE"]),
  overall: z.number(),
  reasoning: z.string(),
  strengthsAcrossRounds: z.array(z.string()),
  concernsAcrossRounds: z.array(z.string()),
  roundSummaries: z.array(
    z.object({
      interviewType: z.string(),
      scheduledAt: z.string(),
      recommendation: z.string(),
      overallRating: z.number().nullable(),
      keyNotes: z.string(),
    }),
  ),
});
export type CompositeScoreResult = z.infer<typeof CompositeScoreSchema>;
