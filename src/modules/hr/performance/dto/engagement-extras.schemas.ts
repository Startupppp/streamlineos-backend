import { z } from "zod";

export const moodCheckinSchema = z.object({
  mood: z.number().int().min(1).max(5),
  note: z.string().max(500).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const createBadgeSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().min(1).max(500),
  icon: z.string().min(1).max(200),
  points: z.number().int().min(0).max(1000).optional(),
});

export const awardBadgeSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export const createPollSchema = z.object({
  question: z.string().min(5).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(10),
  anonymous: z.boolean().optional(),
  closesAt: z.string().optional(),
});

export const votePollSchema = z.object({
  optionIndex: z.number().int().min(0),
});

export const createCommunitySchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
});

export const communityListSchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const createCampaignSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  status: z.enum(["draft", "active", "completed", "cancelled"]).optional(),
  audience: z
    .object({
      type: z.string().min(1),
      ids: z.array(z.string()).optional(),
    })
    .optional(),
});

export const updateCampaignSchema = createCampaignSchema.partial();

export const updatePollSchema = z.object({
  status: z.enum(["draft", "active", "closed"]).optional(),
  question: z.string().min(5).max(500).optional(),
});

export type MoodCheckinInput = z.infer<typeof moodCheckinSchema>;
export type CreateBadgeInput = z.infer<typeof createBadgeSchema>;
export type AwardBadgeInput = z.infer<typeof awardBadgeSchema>;
export type CommunityListInput = z.infer<typeof communityListSchema>;
export type CreatePollInput = z.infer<typeof createPollSchema>;
export type VotePollInput = z.infer<typeof votePollSchema>;
export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type UpdatePollInput = z.infer<typeof updatePollSchema>;
