import { Injectable } from "@nestjs/common";
import { and, eq, exists, notExists, sql } from "drizzle-orm";
import { documentAudiences, kbLinkedDocumentAudiences, kbLinkedDocuments } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

/**
 * The HR side of the knowledge-base link, as seen from the document: how many entries point at it, and
 * keeping their audiences inside the document's own. Everything here runs on the caller's transaction, so a
 * change to a document and its effect on its entries commit or roll back together.
 *
 * Taking a link DOWN when its document stops being publishable is not done here. That is the database's job
 * (`trg_documents_unlink_when_unpublishable`, migration 1200), so it holds for writers that never come
 * through this code, the CSV import among them.
 */
@Injectable()
export class KbLinkedDocumentCeilingService {
  async activeLinkCount(tx: TenantTx, orgId: string, documentId: number): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(kbLinkedDocuments)
      .where(
        and(
          eq(kbLinkedDocuments.orgId, orgId),
          eq(kbLinkedDocuments.documentId, documentId),
          eq(kbLinkedDocuments.status, "active"),
        ),
      )
      .limit(1);
    return row?.total ?? 0;
  }

  /**
   * Remove every link audience the document's audiences no longer cover. A link may show a document to a
   * SUBSET of who the document is for: `ALL_EMPLOYEES` on the document covers any link audience, and a
   * department or location covers only itself. A link left with no audience is visible to publishers only,
   * which is the fail-closed reading. Returns how many audience rows were removed.
   */
  async narrowToCeiling(tx: TenantTx, orgId: string, documentId: number): Promise<number> {
    const ofThisDocument = tx
      .select({ one: sql`1` })
      .from(kbLinkedDocuments)
      .where(
        and(
          eq(kbLinkedDocuments.orgId, orgId),
          eq(kbLinkedDocuments.id, kbLinkedDocumentAudiences.linkedDocumentId),
          eq(kbLinkedDocuments.documentId, documentId),
        ),
      )
      .limit(1);

    const covered = tx
      .select({ one: sql`1` })
      .from(documentAudiences)
      .where(
        and(
          eq(documentAudiences.orgId, orgId),
          eq(documentAudiences.documentId, documentId),
          sql`(
            ${documentAudiences.kind} = 'ALL_EMPLOYEES'
            OR (
              ${documentAudiences.kind} = ${kbLinkedDocumentAudiences.kind}
              AND coalesce(${documentAudiences.refId}, '') = coalesce(${kbLinkedDocumentAudiences.refId}, '')
            )
          )`,
        ),
      )
      .limit(1);

    const removed = await tx
      .delete(kbLinkedDocumentAudiences)
      .where(
        and(
          eq(kbLinkedDocumentAudiences.orgId, orgId),
          exists(ofThisDocument),
          notExists(covered),
        ),
      )
      .returning({ id: kbLinkedDocumentAudiences.id });
    return removed.length;
  }
}
