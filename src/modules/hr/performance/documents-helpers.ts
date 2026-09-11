import { SQL, eq, or, sql } from "drizzle-orm";
import { documents } from "../../../db/schema";
import type { OwnershipScope } from "../../access/scoped-read";

export function formatDateString(value: Date): string {
  return value.toISOString().split("T")[0];
}

// `own` is the caller's membership row; `team` and `all` are keyed on the document's userId, which is what applyScope bound before.
export function documentOwnerScope(
  actorId: string,
  membershipId?: number | null,
): { own: SQL; team: SQL } {
  return {
    own: membershipId == null ? sql`false` : eq(documents.userMembershipId, membershipId),
    team: eq(documents.userId, actorId),
  };
}

// A public document is readable by anyone who may read documents at all, so it widens the ownership arm rather than bypassing the scope.
export function documentReadableScope(actorId: string, membershipId?: number | null): OwnershipScope {
  const owner = documentOwnerScope(actorId, membershipId);
  const isPublic = eq(documents.isPublic, true);
  return {
    own: or(isPublic, owner.own) ?? isPublic,
    team: or(isPublic, owner.team) ?? isPublic,
  };
}

export function documentCategoryCondition(category: string): SQL {
  switch (category) {
    case "Contracts":
      return sql`${documents.type} IN ('CONTRACT', 'OFFER_LETTER')`;
    case "Policies":
      return eq(documents.type, "POLICY");
    case "Tax Forms":
      return sql`(${documents.type} = 'ID_PROOF' OR 'tax' = ANY(${documents.tags}))`;
    case "Templates":
      return sql`'template' = ANY(${documents.tags})`;
    case "Payroll":
      return eq(documents.type, "PAYSLIP");
    case "Archives":
      return eq(documents.type, "OTHER");
    default:
      return sql`(
        ${documents.category} = ${category}
        OR ${category} = ANY(${documents.tags})
      )`;
  }
}

export const documentListSelection = {
  id: documents.id,
  orgId: documents.orgId,
  userId: documents.userId,
  departmentId: documents.departmentId,
  name: documents.name,
  description: documents.description,
  type: documents.type,
  category: documents.category,
  hasFile: sql<boolean>`${documents.fileUrl} <> ''`,
  fileName: documents.fileName,
  fileSize: documents.fileSize,
  mimeType: documents.mimeType,
  version: documents.version,
  parentDocumentId: documents.parentDocumentId,
  isPublic: documents.isPublic,
  isActive: documents.isActive,
  expiryDate: documents.expiryDate,
  expiryReminderSent: documents.expiryReminderSent,
  tags: documents.tags,
  metadata: documents.metadata,
  uploadedBy: documents.uploadedBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};
