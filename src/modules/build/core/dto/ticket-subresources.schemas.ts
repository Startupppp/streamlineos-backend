import { z } from "zod";

export const commentSchema = z.object({
  content: z.string().min(1),
  parentCommentId: z.number().int().positive().optional(),
}).strict();
export type CommentInput = z.infer<typeof commentSchema>;

export const updateCommentSchema = z.object({ content: z.string().min(1) }).strict();
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const addRelationSchema = z.object({
  relatedTicketId: z.number().int().positive(),
  relationType: z.enum(["blocks", "blocked_by", "duplicate_of", "relates_to"]),
}).strict();
export type AddRelationInput = z.infer<typeof addRelationSchema>;

export const removeRelationQuerySchema = z.object({
  relatedId: z.coerce.number().int().positive(),
}).strict();
export type RemoveRelationQuery = z.infer<typeof removeRelationQuerySchema>;

export const addWatcherSchema = z.object({
  userId: z.string().optional(),
}).strict();
export type AddWatcherInput = z.infer<typeof addWatcherSchema>;

export const addLabelSchema = z.object({ labelId: z.number() }).strict();
export type AddLabelInput = z.infer<typeof addLabelSchema>;

export const attachmentSchema = z.object({
  fileName: z.string().min(1),
  fileUrl: z.string().min(1),
  fileSize: z.number(),
  mimeType: z.string(),
}).strict();
export type AttachmentInput = z.infer<typeof attachmentSchema>;

export const addRelatedLinkSchema = z.object({
  url: z.string().url("Must be a valid URL").max(2000),
  label: z.string().trim().max(200).optional(),
}).strict();
export type AddRelatedLinkInput = z.infer<typeof addRelatedLinkSchema>;

export const updateRelatedLinkSchema = z.object({
  url: z.string().url("Must be a valid URL").max(2000).optional(),
  label: z.string().trim().max(200).nullable().optional(),
}).strict();
export type UpdateRelatedLinkInput = z.infer<typeof updateRelatedLinkSchema>;

export const addReactionSchema = z.object({
  emoji: z.string().min(1).max(10),
}).strict();
export type AddReactionInput = z.infer<typeof addReactionSchema>;
