import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

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
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});
export type ListPoolMembersQueryInput = z.infer<typeof listPoolMembersQuerySchema>;
