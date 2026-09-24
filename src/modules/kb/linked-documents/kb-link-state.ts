import { NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { documentAudiences, documentVersions, documents, kbLinkedDocumentAudiences, kbLinkedDocuments, orgUnits } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { publishBlockers } from "../../hr/performance/documents-helpers";
import { MAX_DOCUMENT_AUDIENCES } from "./dto/document-audience-entry.schema";
import type { KbLinkState } from "./dto/kb-link-state-response.schemas";
import { JUDGED_DOCUMENT_COLUMNS } from "./kb-link-judge";

type Reader = Pick<TenantTx, "select">;

async function labelledLinkAudiences(reader: Reader, orgId: string, linkedDocumentId: number) {
  return reader
    .select({ kind: kbLinkedDocumentAudiences.kind, refId: kbLinkedDocumentAudiences.refId, label: orgUnits.name })
    .from(kbLinkedDocumentAudiences)
    .leftJoin(orgUnits, and(eq(orgUnits.orgId, kbLinkedDocumentAudiences.orgId), eq(orgUnits.id, kbLinkedDocumentAudiences.refId)))
    .where(and(eq(kbLinkedDocumentAudiences.orgId, orgId), eq(kbLinkedDocumentAudiences.linkedDocumentId, linkedDocumentId)))
    .orderBy(kbLinkedDocumentAudiences.id)
    .limit(MAX_DOCUMENT_AUDIENCES);
}

async function labelledDocumentAudiences(reader: Reader, orgId: string, documentId: number) {
  return reader
    .select({ kind: documentAudiences.kind, refId: documentAudiences.refId, label: orgUnits.name })
    .from(documentAudiences)
    .leftJoin(orgUnits, and(eq(orgUnits.orgId, documentAudiences.orgId), eq(orgUnits.id, documentAudiences.refId)))
    .where(and(eq(documentAudiences.orgId, orgId), eq(documentAudiences.documentId, documentId)))
    .orderBy(documentAudiences.id)
    .limit(MAX_DOCUMENT_AUDIENCES);
}

/** Where a document stands in the knowledge base: its latest entry (live or not), and whether it could be published right now. */
export async function loadLinkState(reader: Reader, orgId: string, documentId: number): Promise<KbLinkState> {
  const [doc] = await reader.select(JUDGED_DOCUMENT_COLUMNS).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.id, documentId))).limit(1);
  if (!doc) throw new NotFoundException("Document not found.");
  const blockers = publishBlockers(doc);
  const [link] = await reader
    .select({
      id: kbLinkedDocuments.id,
      status: kbLinkedDocuments.status,
      versionMode: kbLinkedDocuments.versionMode,
      pinnedVersion: kbLinkedDocuments.pinnedVersion,
      publishedAt: kbLinkedDocuments.publishedAt,
      unpublishedAt: kbLinkedDocuments.unpublishedAt,
      unpublishReason: kbLinkedDocuments.unpublishReason,
    })
    .from(kbLinkedDocuments)
    .where(and(eq(kbLinkedDocuments.orgId, orgId), eq(kbLinkedDocuments.documentId, documentId)))
    .orderBy(desc(kbLinkedDocuments.id))
    .limit(1);

  let newerVersionAvailable = false;
  if (link?.versionMode === "PINNED" && link.pinnedVersion !== null) {
    const [latest] = await reader
      .select({ version: documentVersions.version })
      .from(documentVersions)
      .where(and(eq(documentVersions.orgId, orgId), eq(documentVersions.documentId, documentId), eq(documentVersions.status, "approved")))
      .orderBy(desc(documentVersions.version))
      .limit(1);
    newerVersionAvailable = latest !== undefined && latest.version > link.pinnedVersion;
  }

  return {
    documentId,
    link: link ? { ...link, audiences: await labelledLinkAudiences(reader, orgId, link.id), newerVersionAvailable } : null,
    publishable: blockers.length === 0,
    blockers,
    documentAudiences: await labelledDocumentAudiences(reader, orgId, documentId),
  };
}
