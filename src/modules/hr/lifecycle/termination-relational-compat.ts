import { and, asc, eq, inArray } from "drizzle-orm";
import {
  isCompatibilityRelationAvailable,
  type CompatibilityDb,
} from "../../../common/db/expand-contract-compat";
import {
  terminationReasons,
  terminationSupportingDocuments,
} from "../../../db/schema/hr/termination-relational-records";

export type TerminationRelationalCollections = {
  reasonsByTerminationId: Map<number, string[]>;
  supportingDocumentsByTerminationId: Map<number, string[]>;
};

export async function loadTerminationRelationalCollections(
  database: CompatibilityDb,
  organizationId: string,
  terminationIds: readonly number[],
): Promise<TerminationRelationalCollections> {
  const uniqueTerminationIds = [...new Set(terminationIds)];
  const reasonsByTerminationId = new Map<number, string[]>();
  const supportingDocumentsByTerminationId = new Map<number, string[]>();
  if (uniqueTerminationIds.length === 0)
    return { reasonsByTerminationId, supportingDocumentsByTerminationId };

  const reasonsAvailable = await isCompatibilityRelationAvailable(
    database,
    "public.termination_reasons",
  );
  if (reasonsAvailable) {
    const reasonRows = await database
      .select({
        terminationId: terminationReasons.terminationId,
        reason: terminationReasons.reason,
      })
      .from(terminationReasons)
      .where(
        and(
          eq(terminationReasons.organizationId, organizationId),
          inArray(terminationReasons.terminationId, uniqueTerminationIds),
        ),
      )
      .orderBy(asc(terminationReasons.terminationId), asc(terminationReasons.sortOrder));
    for (const reasonRow of reasonRows) {
      const terminationReasonList = reasonsByTerminationId.get(reasonRow.terminationId) ?? [];
      terminationReasonList.push(reasonRow.reason);
      reasonsByTerminationId.set(reasonRow.terminationId, terminationReasonList);
    }
  }

  const supportingDocumentsAvailable = await isCompatibilityRelationAvailable(
    database,
    "public.termination_supporting_documents",
  );
  if (supportingDocumentsAvailable) {
    const supportingDocumentRows = await database
      .select({
        terminationId: terminationSupportingDocuments.terminationId,
        legacyUrl: terminationSupportingDocuments.legacyUrl,
      })
      .from(terminationSupportingDocuments)
      .where(
        and(
          eq(terminationSupportingDocuments.organizationId, organizationId),
          inArray(terminationSupportingDocuments.terminationId, uniqueTerminationIds),
        ),
      )
      .orderBy(
        asc(terminationSupportingDocuments.terminationId),
        asc(terminationSupportingDocuments.sortOrder),
      );
    for (const supportingDocumentRow of supportingDocumentRows) {
      const supportingDocumentList =
        supportingDocumentsByTerminationId.get(supportingDocumentRow.terminationId) ?? [];
      supportingDocumentList.push(supportingDocumentRow.legacyUrl);
      supportingDocumentsByTerminationId.set(
        supportingDocumentRow.terminationId,
        supportingDocumentList,
      );
    }
  }

  return { reasonsByTerminationId, supportingDocumentsByTerminationId };
}

export async function syncTerminationReasons(
  transaction: CompatibilityDb,
  organizationId: string,
  terminationId: number,
  reasons: readonly string[],
): Promise<void> {
  if (!(await isCompatibilityRelationAvailable(transaction, "public.termination_reasons")))
    return;

  await transaction
    .delete(terminationReasons)
    .where(
      and(
        eq(terminationReasons.organizationId, organizationId),
        eq(terminationReasons.terminationId, terminationId),
      ),
    );

  const seenReasons = new Set<string>();
  const normalizedReasons: Array<{
    organizationId: string;
    terminationId: number;
    reason: string;
    sortOrder: number;
  }> = [];
  for (const [reasonPosition, reason] of reasons.entries()) {
    if (reason.trim() === "" || seenReasons.has(reason)) continue;
    seenReasons.add(reason);
    normalizedReasons.push({
      organizationId,
      terminationId,
      reason,
      sortOrder: reasonPosition,
    });
  }
  if (normalizedReasons.length > 0)
    await transaction.insert(terminationReasons).values(normalizedReasons);
}
