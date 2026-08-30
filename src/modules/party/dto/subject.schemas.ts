import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

const FIELD_KINDS = [
  "text",
  "email",
  "phone",
  "url",
  "number",
  "money",
  "date",
  "select",
  "badge",
  "longText",
] as const;

const TONES = ["success", "warning", "danger", "info", "neutral"] as const;

/** A key a tenant's own integrations will address, so it is slug-shaped. */
const slug = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, "lowercase letters, digits and dashes, starting with a letter");

const fieldOptionSchema = z
  .object({
    value: z.string().trim().min(1),
    label: z.string().trim().min(1),
    tone: z.enum(TONES).optional(),
  })
  .strict();

export const subjectFieldSchema = z
  .object({
    name: slug,
    label: z.string().trim().min(1),
    kind: z.enum(FIELD_KINDS),
    required: z.boolean().optional(),
    options: z.array(fieldOptionSchema).max(50).optional(),
    hint: z.string().trim().max(200).optional(),
  })
  .strict();

export const createSubjectTypeSchema = z
  .object({
    key: slug,
    singular: z.string().trim().min(1).max(60),
    plural: z.string().trim().min(1).max(60),
    titleField: slug,
    // Capped: a declaration is rendered as a form, and a hundred fields is a
    // screen nobody completes.
    fields: z.array(subjectFieldSchema).min(1).max(40),
  })
  .strict();

export const updateSubjectTypeSchema = createSubjectTypeSchema.partial().strict();

export const listSubjectsQuerySchema = z
  .object({
    subjectTypeId: z.string().trim().optional(),
    typeKey: slug.optional(),
    search: z.string().trim().max(200).optional(),
    cursor: z.string().optional(),
    limit: pageSizeField(20),
  })
  .strict();

export const createSubjectSchema = z
  .object({
    subjectTypeId: z.string().trim().min(1),
    reference: z.string().trim().max(120).optional(),
    status: z.string().trim().max(60).optional(),
    /** Checked against the type's declaration at runtime, not here. */
    values: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const updateSubjectSchema = z
  .object({
    reference: z.string().trim().max(120).nullish(),
    status: z.string().trim().max(60).nullish(),
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const linkPartySchema = z
  .object({
    partyId: z.string().trim().min(1),
    relationship: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z][A-Z0-9_]*$/, "an uppercase snake-case relationship, e.g. OWNER"),
  })
  .strict();

export type CreateSubjectTypeInput = z.infer<typeof createSubjectTypeSchema>;
export type UpdateSubjectTypeInput = z.infer<typeof updateSubjectTypeSchema>;
export type ListSubjectsQuery = z.infer<typeof listSubjectsQuerySchema>;
export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;
export type UpdateSubjectInput = z.infer<typeof updateSubjectSchema>;
export type LinkPartyInput = z.infer<typeof linkPartySchema>;
