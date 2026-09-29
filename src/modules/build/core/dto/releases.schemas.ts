import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const MEANINGFUL_TEXT_RE = /[a-zA-Z0-9À-ɏЀ-ӿ一-鿿]/;
const VERSION_RE = /^v?\d+(\.\d+)*(-[\w.]+)?(\+[\w.]+)?$|^\d{4}\.\d{2}(\.\d+)?$/;

const releaseNameSchema = z
  .string()
  .min(1, "Name is required")
  .trim()
  .min(3, "Name must be at least 3 characters")
  .max(120, "Name must be 120 characters or fewer")
  .refine((v) => MEANINGFUL_TEXT_RE.test(v), "Name must contain at least one letter or number");

const releaseVersionSchema = z
  .string()
  .min(1, "Version is required")
  .trim()
  .max(30, "Version must be 30 characters or fewer")
  .refine(
    (v) => VERSION_RE.test(v.trim()),
    "Enter a valid version, e.g. 1.4.0 or v2.0.0-beta",
  );

export const createReleaseSchema = z.object({
  name: releaseNameSchema,
  version: releaseVersionSchema,
  description: z.string().max(10000, "Release notes must be 10,000 characters or fewer").optional().nullable(),
  status: z.enum(["draft", "released", "archived"]).default("draft"),
  releaseDate: z.string().optional().nullable(),
}).strict();

export const updateReleaseSchema = z.object({
  rowVersion: z.number().int().positive(),
  name: releaseNameSchema.optional(),
  version: releaseVersionSchema.optional(),
  description: z.string().max(10000, "Release notes must be 10,000 characters or fewer").optional().nullable(),
  status: z.enum(["draft", "released", "archived"]).optional(),
  releaseDate: z.string().optional().nullable(),
}).strict();

export const addReleaseTicketSchema = z.object({
  ticketId: z.number().int(),
}).strict();

export const listReleasesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(25),
  status: z.enum(["draft", "released", "archived"]).optional(),
  q: z.string().max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const orgListReleasesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: pageSizeField(50),
    status: z.enum(["draft", "released", "archived"]).optional(),
  })
  .strict();

export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;
export type AddReleaseTicketInput = z.infer<typeof addReleaseTicketSchema>;
export type ListReleasesQuery = z.infer<typeof listReleasesQuerySchema>;
export type OrgListReleasesQuery = z.infer<typeof orgListReleasesQuerySchema>;
