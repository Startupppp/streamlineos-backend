import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { eq, ilike } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import {
  chatAttachments,
  documents,
  onboardingDocuments,
  expenses,
  reimbursements,
  handbookVersions,
  payslipPublications,
  candidateDocumentsVault,
} from "../../db/schema";
import {
  isForeignOrgKey,
  isSensitiveFolderRoot,
  ORG_NAMESPACED_KEY_FOLDERS,
  parseStorageKey,
} from "./storage-key";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  assertKbObjectReadable,
  KB_OBJECT_KEY_FOLDERS,
} from "../kb/wiki/kb-object-access";
import type { KnowledgeAuthorizationService } from "../kb/core/authorization/knowledge-authorization.service";

const CHAT_FOLDER_ROOT = "chat";

export interface QuarantineGate {
  isKeyBlocked(orgId: string, storageKey: string): Promise<boolean>;
}

type FileOwner = {
  orgId: string;
  access:
    | "GENERIC"
    | "HR_DOCUMENT"
    | "ONBOARDING_DOCUMENT"
    | "PAYSLIP"
    | "CANDIDATE_VAULT"
    | "CHAT_ATTACHMENT";
};

function requiresDedicatedAccess(owner: FileOwner): boolean {
  return owner.access !== "GENERIC";
}

function isChannelScoped(owner: FileOwner): boolean {
  return owner.access === "CHAT_ATTACHMENT";
}

/**
 * The single gate every read of a raw object key passes, and it runs on the
 * request that mints the signed URL rather than on the one that listed the
 * file — a permission revoked between the two has to bite.
 *
 * Order matters. The key is refused for naming a foreign organisation before
 * anything is looked up, because a key the client chose is an input, not a
 * fact; only then is ownership resolved from the tables, and only then is the
 * quarantine consulted, so an unscanned or infected object is unreachable on
 * both the signed-URL and the streamed path.
 */
export async function assertKeyReadable(
  db: Db,
  auth: KnowledgeAuthorizationService,
  quarantine: QuarantineGate,
  fileKey: string,
  viewer: CurrentUserContext,
  notFoundMessage: string,
): Promise<void> {
  const orgId = viewer.orgId;
  if (isForeignOrgKey(fileKey, orgId)) throw new NotFoundException(notFoundMessage);

  if (KB_OBJECT_KEY_FOLDERS.has(parseStorageKey(fileKey, orgId).folderRoot)) {
    await assertKbObjectReadable(db, auth, viewer, fileKey, notFoundMessage);
    if (await quarantine.isKeyBlocked(orgId, fileKey))
      throw new NotFoundException(notFoundMessage);
    return;
  }

  const fileOwner = await resolveFileOwner(db, fileKey, orgId);
  if (fileOwner !== null) {
    if (fileOwner.orgId !== orgId) throw new NotFoundException(notFoundMessage);
    // 404, because 403 would confirm a private channel holds this file.
    if (isChannelScoped(fileOwner)) throw new NotFoundException(notFoundMessage);
    if (requiresDedicatedAccess(fileOwner))
      throw new ForbiddenException("Access denied");
  } else if (isSensitiveFolderRoot(parseStorageKey(fileKey, orgId).folderRoot)) {
    throw new NotFoundException(notFoundMessage);
  }

  if (await quarantine.isKeyBlocked(orgId, fileKey))
    throw new NotFoundException(notFoundMessage);
}

/**
 * Protected resource types are denied here even for the same tenant and must use
 * their permission- and record-scoped download endpoint. Omitting a table means a file cannot be proven to belong to any
 * org: callers treat an unresolved sensitive key as a denial, so a missing table locks its
 * own file type out rather than exposing it. Returns the owning orgId, or null if untracked.
 */
async function resolveFileOwner(
  db: Db,
  fileKey: string,
  callerOrgId: string,
): Promise<FileOwner | null> {
  const { ownerOrgId, folderRoot } = parseStorageKey(fileKey, callerOrgId);
  if (ownerOrgId !== null && ORG_NAMESPACED_KEY_FOLDERS.has(folderRoot))
    return { orgId: ownerOrgId, access: "GENERIC" };

  if (folderRoot.toLowerCase() === CHAT_FOLDER_ROOT) {
    const attachment = await db.query.chatAttachments.findFirst({
      where: eq(chatAttachments.fileKey, fileKey),
      columns: { orgId: true },
    });
    return attachment ? { orgId: attachment.orgId, access: "CHAT_ATTACHMENT" } : null;
  }

  const like = `%${fileKey}%`;
  const [doc, onboardingDoc, expense, reimbursement, handbookVersion, payslip, vaultDoc] =
    await Promise.all([
      db.query.documents.findFirst({ where: ilike(documents.fileUrl, like) }),
      db.query.onboardingDocuments.findFirst({ where: ilike(onboardingDocuments.fileUrl, like) }),
      db.query.expenses.findFirst({ where: ilike(expenses.receiptUrl, like) }),
      db.query.reimbursements.findFirst({ where: ilike(reimbursements.receiptUrl, like) }),
      db.query.handbookVersions.findFirst({ where: ilike(handbookVersions.documentUrl, like) }),
      db.query.payslipPublications.findFirst({ where: ilike(payslipPublications.pdfUrl, like) }),
      db.query.candidateDocumentsVault.findFirst({
        where: ilike(candidateDocumentsVault.fileUrl, like),
      }),
    ]);
  if (doc) return { orgId: doc.orgId, access: "HR_DOCUMENT" };
  if (onboardingDoc) return { orgId: onboardingDoc.orgId, access: "ONBOARDING_DOCUMENT" };
  if (payslip) return { orgId: payslip.orgId, access: "PAYSLIP" };
  if (vaultDoc) return { orgId: vaultDoc.orgId, access: "CANDIDATE_VAULT" };
  const genericOrgId =
    expense?.orgId ?? reimbursement?.orgId ?? handbookVersion?.orgId ?? null;
  return genericOrgId ? { orgId: genericOrgId, access: "GENERIC" } : null;
}
