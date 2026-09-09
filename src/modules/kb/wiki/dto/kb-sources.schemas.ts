import { z } from "zod";
import { nullableWireDate } from "../../../../common/openapi/wire-types";

export const createKbSourceNoteSchema = z
  .object({
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(200000),
    spaceId: z.number().int().positive().nullable().optional(),
  })
  .strict();

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

export const kbSourceIdParamsSchema = z
  .object({ sourceId: z.coerce.number().int().positive() })
  .strict();

export const kbPageIdParamsSchema = z
  .object({ pageId: z.coerce.number().int().positive() })
  .strict();

export const kbIngestionStateSchema = z.enum([
  "unknown",
  "pending",
  "in_flight",
  "indexed",
  "failed",
  "suppressed",
]);

export type KbIngestionState = z.infer<typeof kbIngestionStateSchema>;

export const kbPageIngestionStatusSchema = z.object({
  pageId: z.number().int(),
  state: kbIngestionStateSchema,
  retryCount: z.number().int(),
  occurredAt: nullableWireDate(),
  publishedAt: nullableWireDate(),
  deadLetteredAt: nullableWireDate(),
});

export type KbPageIngestionStatus = z.infer<typeof kbPageIngestionStatusSchema>;

export const kbArticleIdParamsSchema = z
  .object({ articleId: z.coerce.number().int().positive() })
  .strict();

export const kbArticleIngestionStatusSchema = z.object({
  articleId: z.number().int(),
  state: kbIngestionStateSchema,
  retryCount: z.number().int(),
  occurredAt: nullableWireDate(),
  publishedAt: nullableWireDate(),
  deadLetteredAt: nullableWireDate(),
});

export type KbArticleIngestionStatus = z.infer<typeof kbArticleIngestionStatusSchema>;
