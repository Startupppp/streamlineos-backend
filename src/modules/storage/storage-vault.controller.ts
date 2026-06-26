import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { candidateDocumentsVault, vaultAccessLogs } from "../../db/schema";
import { StorageService } from "./storage.service";

const VAULT_ROLES: readonly string[] = ["CEO", "HR", "ADMIN"];
const SIGNED_URL_EXPIRY_SECONDS = 900;

@Controller("hr/recruitment/candidates/:candidateId/vault")
@UseGuards(JwtAuthGuard)
export class StorageVaultController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  @Get(":documentId(\\d+)")
  async download(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, VAULT_ROLES)) throw new ForbiddenException("Forbidden");

    const doc = await this.db.query.candidateDocumentsVault.findFirst({
      where: and(
        eq(candidateDocumentsVault.id, documentId),
        eq(candidateDocumentsVault.candidateId, candidateId),
        eq(candidateDocumentsVault.orgId, u.orgId),
      ),
    });
    if (!doc) throw new NotFoundException("Document not found.");

    await this.db.insert(vaultAccessLogs).values({
      vaultDocumentId: documentId,
      accessedBy: u.userId,
      action: "VIEW",
    });

    let signedUrl = doc.fileUrl;
    if (doc.s3Key && this.storage.isConfigured()) {
      try {
        signedUrl = await this.storage.getFileUrl(doc.s3Key, SIGNED_URL_EXPIRY_SECONDS);
      } catch {
        signedUrl = doc.fileUrl;
      }
    }

    return { ...doc, signedUrl };
  }

  @Delete(":documentId(\\d+)")
  async remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, VAULT_ROLES)) throw new ForbiddenException("Forbidden");

    const doc = await this.db.query.candidateDocumentsVault.findFirst({
      where: and(
        eq(candidateDocumentsVault.id, documentId),
        eq(candidateDocumentsVault.candidateId, candidateId),
        eq(candidateDocumentsVault.orgId, u.orgId),
      ),
    });
    if (!doc) throw new NotFoundException("Document not found.");

    await this.db.transaction(async (tx) => {
      await tx.insert(vaultAccessLogs).values({
        vaultDocumentId: documentId,
        accessedBy: u.userId,
        action: "DOWNLOAD",
      });
      await tx.delete(candidateDocumentsVault).where(eq(candidateDocumentsVault.id, documentId));
    });

    return { success: true };
  }
}
