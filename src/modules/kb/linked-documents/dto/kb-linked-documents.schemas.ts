import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const LINKED_DOCUMENT_STATUS_FILTERS = ["active", "unpublished", "source_removed", "all"] as const;

export const listLinkedDocumentsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: pageSizeField(30),
    status: z.enum(LINKED_DOCUMENT_STATUS_FILTERS).optional(),
    q: z.string().trim().min(2).max(200).optional(),
  })
  .strict();
export type ListLinkedDocumentsQuery = z.infer<typeof listLinkedDocumentsQuerySchema>;

export const linkedDocumentParamsSchema = z
  .object({ linkedDocumentId: z.coerce.number().int().positive() })
  .strict();
