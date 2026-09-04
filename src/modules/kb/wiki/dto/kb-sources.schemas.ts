import { z } from "zod";

export const createKbSourceNoteSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(200000),
  spaceId: z.number().int().positive().nullable().optional(),
}).strict();

export type CreateKbSourceNoteInput = z.infer<typeof createKbSourceNoteSchema>;

/**
 * `GET /kb/sources` was a hard `.limit(100)` with nothing to page past it: a tenant with
 * 101 sources could never reach the 101st, and nothing in the response said so. That is
 * silent truncation, not a page size.
 *
 * Keyset, not offset, because the list is written to while it is read — an upload
 * finishing mid-scroll shifts an offset page and the reader sees a duplicate or misses a
 * row. The sort is `(created_at DESC, id DESC)`, so the cursor carries both: `created_at`
 * has no uniqueness and two sources uploaded in the same millisecond would otherwise
 * straddle a page boundary forever.
 */
export const kbSourcesListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type KbSourcesListQuery = z.infer<typeof kbSourcesListQuerySchema>;
