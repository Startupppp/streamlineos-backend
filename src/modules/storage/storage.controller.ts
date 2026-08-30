import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { ilike } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  documents,
  onboardingDocuments,
  expenses,
  reimbursements,
  handbookVersions,
  payslipPublications,
  candidateDocumentsVault,
} from "../../db/schema";
import { StorageService, type FileStreamResult } from "./storage.service";
import { validateMagicBytes } from "./file-signatures";
import { AccessService } from "../access/access.service";
import { AvScanner } from "../../common/security/av-scan";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const SENSITIVE_KEY_PREFIXES = [
  "payroll/",
  "payslips/",
  "hr-documents/",
  "documents/",
  "hr/",
  "onboarding/",
  "onboarding-docs/",
  "candidate-vault/",
  "candidates/",
  "esign/",
  "e-sign/",
  "signatures/",
  "bank-batches/",
  "resignations/",
];

function isSensitiveKey(fileKey: string): boolean {
  const normalized = fileKey.replace(/^\/+/, "").toLowerCase();
  return SENSITIVE_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

type FileOwner = {
  orgId: string;
  access: "GENERIC" | "HR_DOCUMENT" | "ONBOARDING_DOCUMENT" | "PAYSLIP" | "CANDIDATE_VAULT";
};

function requiresDedicatedAccess(owner: FileOwner): boolean {
  return owner.access !== "GENERIC";
}

const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const GENERIC_SENSITIVE_UPLOAD_PERMISSIONS: Readonly<
  Record<string, readonly string[]>
> = {
  documents: ["hr:documents:manage"],
  "hr-documents": ["hr:documents:manage"],
  onboarding: ["self:onboarding-docs", "hr:onboarding:manage"],
  "onboarding-docs": ["self:onboarding-docs", "hr:onboarding:manage"],
  resignations: ["hr:exit:create", "hr:exit:manage"],
};

@Controller("storage")
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly avScanner: AvScanner,
  ) {}

  @Post("upload")
  @AuthorizedInService("assertUploadAllowed")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("folder") folderField: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ url: string; key: string; size: number; mimeType: string }> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not available");
    }
    if (!file) throw new BadRequestException("No file provided");

    const rawFolder = folderField && folderField.length > 0 ? folderField : "uploads";
    const folder = rawFolder.replace(/[^a-zA-Z0-9_-]/g, "-");
    await this.assertUploadAllowed(folder, u);

    if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestException("File too large (max 10MB)");
    if (!ALLOWED_UPLOAD_TYPES.includes(file.mimetype)) {
      throw new BadRequestException("File type not allowed");
    }
    if (!validateMagicBytes(file.buffer, file.mimetype)) {
      throw new BadRequestException("File content does not match declared type");
    }

    const scanResult = await this.avScanner.scan(file.buffer, file.originalname, file.mimetype);
    if (scanResult.status === "infected")
      throw new UnprocessableEntityException(`Upload rejected: malware detected (${scanResult.threat})`);
    if (scanResult.status === "error")
      throw new ServiceUnavailableException("Malware scan unavailable — upload rejected");

    try {
      const result = await this.storage.uploadCompressed(
        u.orgId,
        file.buffer,
        folder,
        file.originalname,
        file.mimetype,
      );
      this.audit.log({
        action: "file.upload",
        userId: u.userId,
        orgId: u.orgId,
        metadata: { fileKey: result.key, fileSize: result.size, mimeType: result.mimeType },
      });
      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new InternalServerErrorException("Failed to upload file");
    }
  }

  @Get("download")
  @AuthorizedInService("resolveFileOwner")
  async download(
    @Query("url") urlParam: string | undefined,
    @Query("key") keyParam: string | undefined,
    @Query("expiresIn") expiresInParam: string | undefined,
    @Query("attachment") attachmentParam: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("Cloud storage not configured");
    }

    const rawExpires = parseInt(expiresInParam ?? "3600", 10);
    const expiresIn = Number.isNaN(rawExpires) ? 3600 : Math.min(Math.max(rawExpires, 60), 86400);
    const attachment = attachmentParam === "1";

    if (!urlParam && !keyParam) throw new BadRequestException("URL or key required");

    const fileKey = keyParam || (urlParam ? this.storage.getFileKeyFromUrl(urlParam) : "");
    if (!fileKey || !this.storage.isValidFileKey(fileKey)) {
      throw new BadRequestException("Invalid file reference");
    }

    const orgId = u.orgId;

    const fileOwner = await this.resolveFileOwner(fileKey);
    if (fileOwner !== null) {
      if (fileOwner.orgId !== orgId) throw new NotFoundException("File not found");
      if (requiresDedicatedAccess(fileOwner)) throw new ForbiddenException("Access denied");
    } else if (isSensitiveKey(fileKey)) {
      throw new NotFoundException("File not found");
    }

    this.audit.log({ action: "file.download", userId: u.userId, orgId, metadata: { fileKey } });

    if (attachment) {
      const stream = await this.openStream(orgId, fileKey, "File not found");
      const filename = this.storage.getFileNameFromKey(fileKey);
      res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(fileKey));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, "%22")}"`,
      );
      this.pipe(stream.body, res);
      return;
    }

    const signedUrl = await this.storage.getFileUrl(orgId, fileKey, expiresIn);
    res.json({ url: signedUrl });
  }

  @Get("image")
  @AuthorizedInService("resolveFileOwner")
  async image(
    @Query("key") keyParam: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    if (!keyParam || !this.storage.isValidFileKey(keyParam)) {
      throw new BadRequestException("Invalid key parameter");
    }
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("Storage not available");
    }

    if (isSensitiveKey(keyParam)) {
      const fileOwner = await this.resolveFileOwner(keyParam);
      if (fileOwner === null || fileOwner.orgId !== u.orgId) {
        throw new NotFoundException("Not found");
      }
      if (requiresDedicatedAccess(fileOwner)) throw new ForbiddenException("Access denied");
    }

    const stream = await this.openStream(u.orgId, keyParam, "Not found");
    res.setHeader("Content-Type", stream.contentType || this.storage.getMimeType(keyParam));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    this.pipe(stream.body, res);
  }

  /**
   * Storage keys aren't org-namespaced, so this is the only place cross-org ownership can be
   * checked. Protected resource types are denied here even for the same tenant and must use
   * their permission- and record-scoped download endpoint. Omitting a table means a file cannot be proven to belong to any
   * org: callers treat an unresolved sensitive key as a denial, so a missing table locks its
   * own file type out rather than exposing it. Returns the owning orgId, or null if untracked.
   */
  private async resolveFileOwner(fileKey: string): Promise<FileOwner | null> {
    const like = `%${fileKey}%`;
    const [doc, onboardingDoc, expense, reimbursement, handbookVersion, payslip, vaultDoc] =
      await Promise.all([
        this.db.query.documents.findFirst({ where: ilike(documents.fileUrl, like) }),
        this.db.query.onboardingDocuments.findFirst({ where: ilike(onboardingDocuments.fileUrl, like) }),
        this.db.query.expenses.findFirst({ where: ilike(expenses.receiptUrl, like) }),
        this.db.query.reimbursements.findFirst({ where: ilike(reimbursements.receiptUrl, like) }),
        this.db.query.handbookVersions.findFirst({ where: ilike(handbookVersions.documentUrl, like) }),
        this.db.query.payslipPublications.findFirst({ where: ilike(payslipPublications.pdfUrl, like) }),
        this.db.query.candidateDocumentsVault.findFirst({
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

  private async assertUploadAllowed(
    folder: string,
    user: CurrentUserContext,
  ): Promise<void> {
    const required = GENERIC_SENSITIVE_UPLOAD_PERMISSIONS[folder];
    const isSensitive = isSensitiveKey(`${folder}/file`);
    if (!isSensitive) return;
    if (user.isOrgOwner && required) return;
    if (!required) throw new ForbiddenException("Use the feature-specific upload endpoint");

    const permissions = await this.access.resolveUserPermissions(
      user.orgId,
      user.userId,
    );
    if (!required.some((permission) => permissions.has(permission))) {
      throw new ForbiddenException("Access denied");
    }
  }

  private async openStream(
    orgId: string,
    key: string,
    notFoundMessage: string,
  ): Promise<FileStreamResult> {
    try {
      return await this.storage.getFileStream(orgId, key);
    } catch {
      throw new NotFoundException(notFoundMessage);
    }
  }

  private pipe(body: NodeJS.ReadableStream, res: Response): void {
    body.on("error", () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    body.pipe(res);
  }
}
