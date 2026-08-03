import { z } from "zod";

export const createTalentPoolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});
export type CreateTalentPoolInput = z.infer<typeof createTalentPoolSchema>;

export const updateTalentPoolSchema = createTalentPoolSchema.partial();
export type UpdateTalentPoolInput = z.infer<typeof updateTalentPoolSchema>;

export const addPoolMemberSchema = z.object({
  candidateId: z.number().int().positive(),
  notes: z.string().max(1000).optional(),
});
export type AddPoolMemberInput = z.infer<typeof addPoolMemberSchema>;

export const listPoolMembersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListPoolMembersQueryInput = z.infer<typeof listPoolMembersQuerySchema>;
