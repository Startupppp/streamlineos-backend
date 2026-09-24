import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

/**
 * Tags are normalised on the way in — trimmed, lowercased, deduped — because
 * they are matched by equality in a filter. "Bengaluru" and "bengaluru" typed
 * into two pools on two days are the same tag to the recruiter reading the
 * list, and would be two entries in the filter without this.
 */
const poolTagsField = z
  .array(z.string().trim().min(1).max(40))
  .max(20)
  .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]);

export const createTalentPoolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tags: poolTagsField.optional(),
}).strict();
export type CreateTalentPoolInput = z.infer<typeof createTalentPoolSchema>;

export const updateTalentPoolSchema = createTalentPoolSchema.partial().strict();
export type UpdateTalentPoolInput = z.infer<typeof updateTalentPoolSchema>;

export const addPoolMemberSchema = z.object({
  candidateId: z.number().int().positive(),
  notes: z.string().max(1000).optional(),
}).strict();
export type AddPoolMemberInput = z.infer<typeof addPoolMemberSchema>;

export const listPoolMembersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();
export type ListPoolMembersQueryInput = z.infer<typeof listPoolMembersQuerySchema>;
