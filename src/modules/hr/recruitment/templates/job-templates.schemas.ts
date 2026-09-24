import { z } from "zod";
import { optionalPageSizeField } from "../../../../common/pagination/list-query.schema";
import {
  JOB_STATUSES,
  MAX_SALARY,
  VALID_JOB_TYPES,
  screeningQuestionSchema,
} from "../dto/jobs.schemas";

/**
 * The authored half of a posting, and nothing else.
 *
 * Every field but `name` is optional: a half-written template is the normal
 * state of one, and refusing to save it would push recruiters back to
 * re-typing the posting from scratch, which is the problem this exists to fix.
 */
const templatePayloadShape = {
  title: z.string().trim().min(2).max(100).optional(),
  description: z.string().max(10_000).optional(),
  requirements: z.string().max(5000).optional(),
  benefits: z.string().max(5000).optional(),
  type: z.enum(VALID_JOB_TYPES).optional(),
  experience: z.string().max(100).optional(),
  screeningQuestions: z.array(screeningQuestionSchema).max(20).optional(),
  jobLevelId: z.number().int().positive().optional(),
} as const;

export const createJobTemplateSchema = z
  .object({
    /** The library label. Trimmed here so " Backend" and "Backend" collide on the unique index rather than sitting beside each other. */
    name: z.string().trim().min(2).max(120),
    ...templatePayloadShape,
  })
  .strict();
export type CreateJobTemplateInput = z.infer<typeof createJobTemplateSchema>;

export const updateJobTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    ...templatePayloadShape,
  })
  .strict()
  .partial();
export type UpdateJobTemplateInput = z.infer<typeof updateJobTemplateSchema>;

export const jobTemplateListSchema = z
  .object({
    type: z.enum(VALID_JOB_TYPES).optional(),
    cursor: z.string().optional(),
    limit: optionalPageSizeField(),
  })
  .strict()
  .transform((q) => ({ type: q.type, cursor: q.cursor, limit: q.limit ?? 20 }));
export type JobTemplateListInput = z.output<typeof jobTemplateListSchema>;

/**
 * What the recruiter typed on the create screen, all of it optional.
 *
 * A key present here wins over the template, a key absent falls back to it.
 * Optional rather than nullable on purpose: `.strict()` drops an omitted key
 * entirely, so key presence is exactly "the caller said something about this
 * field" — which is the question the merge has to answer.
 */
export const applyJobTemplateSchema = z
  .object({
    title: z.string().trim().min(2).max(100).optional(),
    departmentId: z.string().min(1).optional(),
    hiringFlowId: z.number().int().positive().optional(),
    location: z.string().trim().min(2).max(100).optional(),
    type: z.enum(VALID_JOB_TYPES).optional(),
    experience: z.string().max(100).optional(),
    salaryMin: z.number().min(1).max(MAX_SALARY).optional(),
    salaryMax: z.number().min(1).max(MAX_SALARY).optional(),
    description: z.string().max(10_000).optional(),
    requirements: z.string().max(5000).optional(),
    benefits: z.string().max(5000).optional(),
    openings: z.number().int().min(1).max(999).optional(),
    applicationDeadline: z.string().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    screeningQuestions: z.array(screeningQuestionSchema).max(20).optional(),
  })
  .strict();
export type ApplyJobTemplateInput = z.infer<typeof applyJobTemplateSchema>;

export const jobTemplateSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  requirements: z.string().nullable(),
  benefits: z.string().nullable(),
  type: z.string(),
  experience: z.string().nullable(),
  screeningQuestions: z.array(screeningQuestionSchema).nullable(),
  jobLevelId: z.number().int().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const jobTemplateListResponseSchema = z.object({
  data: z.array(jobTemplateSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

/**
 * The draft the create screen re-renders after a template has filled its gaps.
 *
 * `type` widens to a plain string because the stored column is text. The enum
 * guards what a recruiter may *save*; re-narrowing a value the database handed
 * back would need a type assertion, which this repo forbids outright.
 */
export const appliedJobTemplateDraftSchema = applyJobTemplateSchema.extend({
  type: z.string().optional(),
});

/**
 * The template is named in the response so the picker can show what it applied
 * without holding a second copy of the library in component state.
 */
export const appliedJobTemplateSchema = z.object({
  jobTemplateId: z.number().int(),
  jobTemplateName: z.string(),
  draft: appliedJobTemplateDraftSchema,
});
