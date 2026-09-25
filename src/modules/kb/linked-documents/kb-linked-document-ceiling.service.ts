import { Injectable } from "@nestjs/common";
import { and, eq, exists, notExists, sql } from "drizzle-orm";
import { documentAudiences, kbLinkedDocumentAudiences, kbLinkedDocuments } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

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
