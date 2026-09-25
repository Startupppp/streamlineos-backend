import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { documentAudiences, documents } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { publishBlockers, type PublishBlocker } from "../../hr/performance/documents-helpers";
import { withMetadataPiiBlocker } from "../../hr/performance/document-pii-scan";
import { assertAudienceTargetsExist, audienceKey, dedupeAudiences, notPublishableError, type AudienceKey } from "./document-audience-targets";
import { MAX_DOCUMENT_AUDIENCES } from "./dto/document-audience-entry.schema";

type Reader = Pick<TenantTx, "select">;

export const JUDGED_DOCUMENT_COLUMNS = {
  id: documents.id,
  orgId: documents.orgId,
  fileUrl: documents.fileUrl,
  type: documents.type,
  userId: documents.userId,
  uploadedBy: documents.uploadedBy,
  classification: documents.classification,
  isActive: documents.isActive,
  metadata: documents.metadata,
  name: documents.name,
  description: documents.description,
  category: documents.category,
  tags: documents.tags,
} as const;

export interface Verdict {
  audiences: AudienceKey[];
  blockers: PublishBlocker[];
  refusal: HttpException | null;
}

function coveredBy(ceiling: readonly AudienceKey[], audience: AudienceKey): boolean {
  return ceiling.some((entry) => entry.kind === "ALL_EMPLOYEES" || audienceKey(entry) === audienceKey(audience));
}

export async function judgeAudience(
  reader: Reader,
  orgId: string,
  documentId: number,
  requested: ReadonlyArray<{ kind: AudienceKey["kind"]; refId?: string | null }> | undefined,
  lock = false,
): Promise<Verdict> {
  const query = reader.select(JUDGED_DOCUMENT_COLUMNS).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.id, documentId))).limit(1);
  const [doc] = lock ? await query.for("update") : await query;
  if (!doc) throw new NotFoundException("Document not found.");

  const ceiling: AudienceKey[] = await reader
    .select({ kind: documentAudiences.kind, refId: documentAudiences.refId })
    .from(documentAudiences)
    .where(and(eq(documentAudiences.orgId, orgId), eq(documentAudiences.documentId, documentId)))
    .limit(MAX_DOCUMENT_AUDIENCES);
  const audiences = requested === undefined ? ceiling : dedupeAudiences(requested);
  const blockers = withMetadataPiiBlocker(publishBlockers(doc), doc);
  if (blockers.length > 0) return { audiences, blockers, refusal: notPublishableError(blockers) };

  await assertAudienceTargetsExist(reader, orgId, audiences);
  const excess = audiences.filter((audience) => !coveredBy(ceiling, audience));
  if (excess.length === 0) return { audiences, blockers: [], refusal: null };
  return {
    audiences,
    blockers: [],
    refusal: new HttpException(
      { code: "AUDIENCE_EXCEEDS_DOCUMENT", message: "The entry would show the document to more people than the document itself is for.", details: { excess } },
      HttpStatus.UNPROCESSABLE_ENTITY,
    ),
  };
}
