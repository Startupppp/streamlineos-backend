import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const documentNode = z.record(z.string(), z.unknown());
const documentContent = z.union([z.array(documentNode), documentNode]);

export const createPageSchema = z.object({
  parentPageId: z.coerce.number().int().positive().nullable().optional(),
  spaceId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().max(500).optional(),
  templateId: z.coerce.number().int().positive().nullable().optional(),
  projectId: z.coerce.number().int().positive().nullable().optional(),
}).strict();
export type CreatePageInput = z.infer<typeof createPageSchema>;

export const updatePageSchema = z.object({
  spaceId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().max(500).optional(),
  icon: z.string().max(100).nullable().optional(),
  coverImage: z.string().max(2000).nullable().optional(),
  content: documentContent.optional(),
  contentText: z.string().max(200000).optional(),
  status: z.enum(["draft", "in_review", "published", "archived"]).optional(),
  contentType: z
    .enum([
      "note",
      "sop",
      "policy",
      "support_article",
      "troubleshooting",
      "decision_record",
      "meeting_notes",
      "runbook",
      "project_brief",
      "playbook",
    ])
    .optional(),
  ownerUserId: z.string().nullable().optional(),
  changeSummary: z.string().max(500).optional(),
  expectedContentRevision: z.coerce.number().int().positive().optional(),
}).strict();
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export const verifyPageSchema = z.object({
  intervalDays: z.coerce.number().int().positive().optional(),
}).strict();
export type VerifyPageInput = z.infer<typeof verifyPageSchema>;

export const movePageSchema = z.object({
  parentPageId: z.coerce.number().int().positive().nullable(),
  index: z.coerce.number().int().min(0).default(0),
}).strict();
export type MovePageInput = z.infer<typeof movePageSchema>;

export const lockPageSchema = z.object({
  isLocked: z.boolean(),
}).strict();
export type LockPageInput = z.infer<typeof lockPageSchema>;

export const searchPagesSchema = z.object({
  q: z.string().trim().max(200).default(""),
}).strict();
export type SearchPagesInput = z.infer<typeof searchPagesSchema>;

export const listPagesSchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
}).strict();
export type ListPagesInput = z.infer<typeof listPagesSchema>;

export const setVisibilitySchema = z.object({
  visibility: z.enum(["private", "org", "public"]),
}).strict();
export type SetVisibilityInput = z.infer<typeof setVisibilitySchema>;

export const listVersionsQuerySchema = z
  .object({ cursor: z.string().optional(), pageSize: pageSizeField(50, 100) })
  .strict();
export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;
