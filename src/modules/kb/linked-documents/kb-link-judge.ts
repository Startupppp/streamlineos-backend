import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { documentAudiences, documents } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { publishBlockers, type PublishBlocker } from "../../hr/performance/documents-helpers";
import { assertAudienceTargetsExist, audienceKey, dedupeAudiences, notPublishableError, type AudienceKey } from "./document-audience-targets";
import { MAX_DOCUMENT_AUDIENCES } from "./dto/document-audience-entry.schema";

type Reader = Pick<TenantTx, "select">;

export const JUDGED_DOCUMENT_COLUMNS = {
  id: documents.id,
  type: documents.type,
  userId: documents.userId,
  uploadedBy: documents.uploadedBy,
  classification: documents.classification,
  isActive: documents.isActive,
  metadata: documents.metadata,
} as const;

export interface Verdict {
  audiences: AudienceKey[];
  blockers: PublishBlocker[];
  refusal: HttpException | null;
}

/** An audience is inside the ceiling when the ceiling says everyone, or names that very department or location. */
function coveredBy(ceiling: readonly AudienceKey[], audience: AudienceKey): boolean {
  return ceiling.some((entry) => entry.kind === "ALL_EMPLOYEES" || audienceKey(entry) === audienceKey(audience));
}

/**
 * Is publishing (or re-scoping to) this audience allowed for this document, right now? Returns the audience to
 * write and, when it is not allowed, the exception to throw. Run once unlocked, so a refusal can be audited before
 * the throw, and again under the row lock inside the transaction, so the answer that is acted on is the current
 * one. `requested` omitted means "the same people the document is for".
 */
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
  const blockers = publishBlockers(doc);
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
