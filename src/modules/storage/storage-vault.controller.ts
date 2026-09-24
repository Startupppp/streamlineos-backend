import {
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UnprocessableEntityException,
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
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { vaultDownloadResponseSchema } from "./dto/storage-response.schemas";
import { z } from "zod";

const candidateAndDocumentIdParams = z.object({ candidateId: z.coerce.number().int().positive(), documentId: z.coerce.number().int().positive() }).strict();

const SIGNED_URL_EXPIRY_SECONDS = 900;

/**
 * `s3Key` and `fileUrl` are deliberately absent. Presigning the object and then
 * spreading the whole row beside it hands the caller the permanent address as
 * well as the short-lived one, which is the leak this endpoint exists to close;
 * and once the backfill has rewritten `fileUrl` to a bare object key, returning
 * it is still a tenant object key on a bucket that is not yet private.
 */
export interface VaultDownloadResponse {
  readonly id: number;
  readonly candidateId: number;
  readonly filename: string;
  readonly fileType: string;
  readonly fileSize: number;
  readonly documentType: string | null;
  readonly avResult: "PENDING" | "CLEAN" | "INFECTED";
  readonly expiresAt: string | null;
  readonly createdAt: Date;
  readonly signedUrl: string | null;
}

@Controller("hr/recruitment/candidates/:candidateId/vault")
@UseGuards(JwtAuthGuard)
export class StorageVaultController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly access: AccessService,
  ) {}

  @Post(":documentId/url")
  @ResponseSchema(vaultDownloadResponseSchema)
  @BodylessAction()
  @AuthorizedInService("resolveUserPermissions(hr:documents:manage) + org-scoped lookup")
  @HttpCode(200)
  @Validate({ params: candidateAndDocumentIdParams })
  async download(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<VaultDownloadResponse> {
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
      orgId: u.orgId,
      candidateId,
      vaultDocumentId: documentId,
      filename: doc.filename,
      documentType: doc.documentType,
      accessedBy: u.userId,
      action: "VIEW",
    });

    /**
     * An infected object has no authorised reader. The row's `av_result` was
     * returned to the caller and otherwise ignored, so a document a scanner had
     * flagged still produced a signed URL. `PENDING` is not refused — that is
     * the normal state for a file uploaded where no scanner is configured, and
     * blocking it would make every résumé unreadable on such a deployment —
     * but the response says the file is unscanned so the UI can warn.
     */
    if (doc.avResult === "INFECTED")
      throw new UnprocessableEntityException(
        "This file was flagged by malware scanning and cannot be downloaded.",
      );

    const key =
      doc.s3Key.trim().length > 0 ? doc.s3Key : this.storage.getFileKeyFromUrl(doc.fileUrl);

    let signedUrl: string | null = null;
    if (key.length > 0 && this.storage.isConfigured()) {
      try {
        signedUrl = await this.storage.getFileUrl(u.orgId, key, SIGNED_URL_EXPIRY_SECONDS, undefined, {
          preauthorized: true,
        });
      } catch {
        signedUrl = null;
      }
    }

    return {
      id: doc.id,
      candidateId: doc.candidateId,
      filename: doc.filename,
      fileType: doc.fileType,
      fileSize: doc.fileSize,
      documentType: doc.documentType,
      avResult: doc.avResult,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
      signedUrl,
    };
  }
}
