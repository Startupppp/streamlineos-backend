import {
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { candidateDocumentsVault, vaultAccessLogs } from "../../db/schema";
import { AccessService } from "../access/access.service";
import { StorageService } from "./storage.service";

const SIGNED_URL_EXPIRY_SECONDS = 900;

@Controller("hr/recruitment/candidates/:candidateId/vault")
@UseGuards(JwtAuthGuard)
export class StorageVaultController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly access: AccessService,
  ) {}

  @Post(":documentId/url")
  @AuthorizedInService("resolveUserPermissions(hr:documents:manage) + org-scoped lookup")
  @HttpCode(200)
  async download(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<typeof candidateDocumentsVault.$inferSelect & { signedUrl: string | null }> {
    if (!u.isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:documents:manage")) {
        throw new ForbiddenException("Forbidden");
      }
    }

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
        signedUrl = await this.storage.getFileUrl(u.orgId, doc.s3Key, SIGNED_URL_EXPIRY_SECONDS);
      } catch {
        signedUrl = doc.fileUrl;
      }
    }

    return { ...doc, signedUrl };
  }
}
