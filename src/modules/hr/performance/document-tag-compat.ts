import { and, asc, eq, inArray } from "drizzle-orm";
import {
  isCompatibilityRelationAvailable,
  type CompatibilityDb,
} from "../../../common/db/expand-contract-compat";
import { hrDocumentTags } from "../../../db/schema/hr/document-tags";

export async function loadDocumentTags(
  database: CompatibilityDb,
  organizationId: string,
  documentIds: readonly number[],
): Promise<Map<number, string[]>> {
  const uniqueDocumentIds = [...new Set(documentIds)];
  if (
    uniqueDocumentIds.length === 0 ||
    !(await isCompatibilityRelationAvailable(
      database,
      "public.hr_document_tags",
    ))
  )
    return new Map();
  if (uniqueDocumentIds.length > 1000)
    throw new Error(
      "Document tag lookup exceeds the supported 1000-document bound",
    );

  const tagRows = await database
    .select({
      documentId: hrDocumentTags.documentId,
      tag: hrDocumentTags.tag,
    })
    .from(hrDocumentTags)
    .where(
      and(
        eq(hrDocumentTags.organizationId, organizationId),
        inArray(hrDocumentTags.documentId, uniqueDocumentIds),
      ),
    )
    .orderBy(asc(hrDocumentTags.documentId), asc(hrDocumentTags.sortOrder))
    .limit(10000);

  const tagsByDocumentId = new Map<number, string[]>();
  for (const tagRow of tagRows) {
    const documentTags = tagsByDocumentId.get(tagRow.documentId) ?? [];
    documentTags.push(tagRow.tag);
    tagsByDocumentId.set(tagRow.documentId, documentTags);
  }
  return tagsByDocumentId;
}

export async function syncDocumentTags(
  transaction: CompatibilityDb,
  organizationId: string,
  documentId: number,
  tags: readonly string[],
): Promise<void> {
  if (
    !(await isCompatibilityRelationAvailable(
      transaction,
      "public.hr_document_tags",
    ))
  )
    return;

  await transaction
    .delete(hrDocumentTags)
    .where(
      and(
        eq(hrDocumentTags.organizationId, organizationId),
        eq(hrDocumentTags.documentId, documentId),
      ),
    );

  const seenTags = new Set<string>();
  const normalizedTags: Array<{
    organizationId: string;
    documentId: number;
    tag: string;
    sortOrder: number;
  }> = [];
  for (const [tagPosition, tag] of tags.entries()) {
    if (tag.trim() === "" || seenTags.has(tag)) continue;
    seenTags.add(tag);
    normalizedTags.push({
      organizationId,
      documentId,
      tag,
      sortOrder: tagPosition,
    });
  }
  if (normalizedTags.length > 0)
    await transaction.insert(hrDocumentTags).values(normalizedTags);
}
