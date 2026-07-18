import { z } from "zod";

const COURSE_TYPES = ["INTERNAL", "EXTERNAL", "BLENDED"] as const;
const COURSE_FORMATS = ["SELF_PACED", "ILT", "VIRTUAL", "BLENDED"] as const;
const COURSE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

const optionalDecimalString = (label: string) =>
  z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().regex(/^\d+(\.\d{1,2})?$/, `${label} must be a valid decimal number`).optional(),
  );

export const createCourseSchema = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  title: z.string().trim().min(1, "Title is required").max(200, "Title must be at most 200 characters"),
  description: z.string().trim().max(5000, "Description must be at most 5000 characters").optional(),
  instructorId: z.string().trim().min(1, "Instructor is required").optional(),
  externalInstructor: z.string().trim().max(200, "Instructor name must be at most 200 characters").optional(),
  type: z.enum(COURSE_TYPES).optional().default("INTERNAL"),
  format: z.enum(COURSE_FORMATS).optional().default("SELF_PACED"),
  durationHours: optionalDecimalString("Duration hours"),
  prerequisites: z.array(z.coerce.number().int().positive()).max(50, "At most 50 prerequisites are allowed").optional(),
  thumbnailUrl: z.string().trim().url("Enter a valid URL").max(2000).optional().or(z.literal("")),
  status: z.enum(COURSE_STATUSES).optional().default("DRAFT"),
  isMandatory: z.boolean().optional().default(false),
  tags: z.array(z.string().trim().min(1).max(50)).max(50, "At most 50 tags are allowed").optional(),
});

export const updateCourseSchema = z.object({
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(200, "Title must be at most 200 characters").optional(),
  description: z.string().trim().max(5000, "Description must be at most 5000 characters").optional(),
  instructorId: z.string().trim().min(1, "Instructor is required").nullable().optional(),
  externalInstructor: z.string().trim().max(200, "Instructor name must be at most 200 characters").nullable().optional(),
  type: z.enum(COURSE_TYPES).optional(),
  format: z.enum(COURSE_FORMATS).optional(),
  durationHours: optionalDecimalString("Duration hours"),
  prerequisites: z.array(z.coerce.number().int().positive()).max(50, "At most 50 prerequisites are allowed").optional(),
  thumbnailUrl: z.string().trim().url("Enter a valid URL").max(2000).optional().or(z.literal("")),
  status: z.enum(COURSE_STATUSES).optional(),
  isMandatory: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50, "At most 50 tags are allowed").optional(),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
