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

/**
 * Types that describe the company rather than a person. Everything else on the enum (contracts,
 * certificates, ID proofs, payslips, offer letters, resumes) is about an individual and is never
 * company-wide, whatever a flag on the row says. An allowlist, so a value added to the enum later
 * is personal until someone decides otherwise.
 */
export const COMPANY_LEVEL_DOCUMENT_TYPES = ["POLICY", "OTHER"] as const;

/**
 * A document is company-level when it is a company type and belongs to nobody but the person who
 * filed it. `POST /hr/documents` assigns the uploader as owner when no employee is chosen, so
 * "owned by the uploader" is how an HR-uploaded handbook looks; a row owned by a *different* user is
 * that user's file. Rows with no uploader (import, onboarding, recruitment handoff) and an owner are
 * personal.
 */
export function isCompanyLevelDocument(row: {
  type: string;
  userId: string | null;
  uploadedBy: string | null;
}): boolean {
  return (
    (COMPANY_LEVEL_DOCUMENT_TYPES as readonly string[]).includes(row.type) &&
    (row.userId === null || row.userId === row.uploadedBy)
  );
}

// The SQL twin of isCompanyLevelDocument; keep the two in step (documents-helpers.spec.ts pins that).
export function companyLevelDocumentSql(): SQL {
  return sql`(${documents.type} IN ('POLICY', 'OTHER') AND (${documents.userId} IS NULL OR ${documents.userId} = ${documents.uploadedBy}))`;
}

/**
 * A public document is readable by anyone who may read documents at all, so it widens the ownership
 * arm rather than bypassing the scope. `isPublic` is honoured only on a company-level document: the
 * flag was accepted on any type, and ids are serial, so a payslip or ID proof marked public was
 * enumerable through the file route by every viewer.
 */
export function documentReadableScope(actorId: string, membershipId?: number | null): OwnershipScope {
  const owner = documentOwnerScope(actorId, membershipId);
  const isPublic = sql`(${documents.isPublic} = true AND ${companyLevelDocumentSql()})`;
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
