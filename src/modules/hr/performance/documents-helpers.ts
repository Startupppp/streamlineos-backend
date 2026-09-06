import { ForbiddenException } from "@nestjs/common";
import { SQL, eq, sql } from "drizzle-orm";
import { documents } from "../../../db/schema";
import { applyScope } from "../../access/apply-scope";
export { applyScope };
import type { DataScope } from "../../access/access.types";

export function formatDateString(value: Date): string {
  return value.toISOString().split("T")[0];
}

export function documentOwnerPredicate(
  scope: DataScope,
  orgId: string,
  userId: string,
  membershipId?: number | null,
): SQL {
  if (scope === "own") {
    if (membershipId == null)
      throw new ForbiddenException("Organization membership required.");
    return eq(documents.userMembershipId, membershipId);
  }
  return applyScope(scope, orgId, userId, { ownerColumn: documents.userId });
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
