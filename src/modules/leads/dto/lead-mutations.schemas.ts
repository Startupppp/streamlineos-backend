import { z } from "zod";

const LEAD_STATUSES = ["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"] as const;
const LEAD_PRIORITIES = ["HOT", "WARM", "COLD"] as const;
const LEAD_SOURCES = ["referral", "campaign", "cold_call", "website", "social_media", "walk_in", "other"] as const;
const MERGE_FIELD_SIDES = ["winner", "loser"] as const;

export const logActivitySchema = z.object({
  type: z.enum(["call", "email", "whatsapp", "meeting", "site_visit"]),
  date: z.string(),
  duration: z.number().optional(),
  subject: z.string().optional(),
  location: z.string().optional(),
  locationLink: z.string().optional(),
  messageSummary: z.string().optional(),
  notes: z.string().optional(),
  outcome: z.string().optional(),
});

export const customDataSchema = z.object({
  customData: z.record(z.string(), z.unknown()),
});

export const verifySchema = z.object({
  priority: z.enum(LEAD_PRIORITIES).optional(),
  notes: z.string().optional(),
});

export const rejectSchema = z.object({
  reason: z.string().optional(),
});

export const assignSchema = z.object({
  assignedToId: z.string(),
});

export const transitionLeadStatusSchema = z.object({
  status: z.enum(LEAD_STATUSES),
  expectedStatus: z.enum(LEAD_STATUSES).optional(),
  lostReason: z.string().optional(),
  estimatedInvestment: z.string().optional(),
  conversionNotes: z.string().optional(),
});

export const leadMergeSchema = z.object({
  mergeLeadId: z.number().int().positive(),
});

export const topMergeSchema = z.object({
  winnerId: z.number().int().positive(),
  loserId: z.number().int().positive(),
  overrides: z
    .object({
      name: z.enum(MERGE_FIELD_SIDES).optional(),
      email: z.enum(MERGE_FIELD_SIDES).optional(),
      phone: z.enum(MERGE_FIELD_SIDES).optional(),
      company: z.enum(MERGE_FIELD_SIDES).optional(),
      city: z.enum(MERGE_FIELD_SIDES).optional(),
      source: z.enum(MERGE_FIELD_SIDES).optional(),
      notes: z.enum(MERGE_FIELD_SIDES).optional(),
      priority: z.enum(MERGE_FIELD_SIDES).optional(),
      assignedToId: z.enum(MERGE_FIELD_SIDES).optional(),
      tags: z.enum(MERGE_FIELD_SIDES).optional(),
    })
    .default({}),
});

export const bulkUpdateSchema = z.object({
  leadIds: z.array(z.number()).min(1),
  update: z.object({
    status: z.enum(LEAD_STATUSES).optional(),
    priority: z.enum(LEAD_PRIORITIES).optional(),
    assignedToId: z.string().optional(),
  }),
});

export const bulkDeleteSchema = z.object({
  leadIds: z.array(z.number()).min(1),
});

export const importRowSchema = z.object({
  name: z.string().min(1, "Lead name is required"),
  email: z.string().optional().or(z.literal("")),
  phone: z.string().optional(),
  company: z.string().optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  notes: z.string().optional(),
  city: z.string().optional(),
  designation: z.string().optional(),
  referredBy: z.string().optional(),
  potentialValue: z.string().optional(),
  investmentInterest: z.string().optional(),
  whatsappNumber: z.string().optional(),
  website: z.string().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  tags: z.array(z.string()).optional(),
});

export const importSchema = z.object({
  leads: z.array(importRowSchema).min(1).max(1000),
  duplicateAction: z.enum(["skip", "update", "import"]).default("skip"),
  autoDistribute: z.boolean().default(true),
});

export const distributeSchema = z.object({
  leadIds: z.array(z.number()).min(1),
  skipAbsent: z.boolean().default(true),
});

export type LogActivityInput = z.infer<typeof logActivitySchema>;
export type CustomDataInput = z.infer<typeof customDataSchema>;
export type VerifyInput = z.infer<typeof verifySchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type AssignInput = z.infer<typeof assignSchema>;
export type TransitionLeadStatusInput = z.infer<typeof transitionLeadStatusSchema>;
export type LeadMergeInput = z.infer<typeof leadMergeSchema>;
export type TopMergeInput = z.infer<typeof topMergeSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type BulkDeleteInput = z.infer<typeof bulkDeleteSchema>;
export type ImportRowInput = z.infer<typeof importRowSchema>;
export type ImportInput = z.infer<typeof importSchema>;
export type DistributeInput = z.infer<typeof distributeSchema>;
