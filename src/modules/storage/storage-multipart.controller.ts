import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { Validate } from "../../common/validation/validate.decorator";
import { StorageService } from "./storage.service";
import { StorageMultipartService } from "./storage-multipart.service";
import { FileQuarantineService } from "./file-quarantine.service";
import { validateMagicBytes } from "./file-signatures";
import { isForeignOrgKey } from "./storage-key";
import {
  initiateMultipartSchema,
  completeMultipartSchema,
  abortMultipartSchema,
  MAX_MULTIPART_BYTES,
  type InitiateMultipartInput,
  type CompleteMultipartInput,
  type AbortMultipartInput,
} from "./dto/storage-multipart.schemas";

const ORG_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const USER_QUOTA_BYTES = 500 * 1024 * 1024;
const SIGNATURE_SAMPLE_BYTES = 32;

const ALLOWED_MULTIPART_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

@Controller("storage/multipart")
@UseGuards(JwtAuthGuard)
export class StorageMultipartController {
  constructor(
    private readonly storage: StorageService,
    private readonly multipart: StorageMultipartService,
    private readonly quarantine: FileQuarantineService,
    private readonly audit: AuditService,
  ) {}

  @Post("initiate")
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:files:manage")
  @Validate({ body: initiateMultipartSchema })
  async initiate(
    @Body() body: InitiateMultipartInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!this.storage.isConfigured())
      throw new ServiceUnavailableException("File storage is not available");
    if (!ALLOWED_MULTIPART_TYPES.has(body.mimeType))
      throw new BadRequestException("MIME type not permitted for multipart upload");
    if (body.sizeBytes > MAX_MULTIPART_BYTES)
      throw new PayloadTooLargeException("File exceeds the multipart size limit");

    const [orgUsed, userUsed] = await Promise.all([
      this.quarantine.getTotalUsageBytes(u.orgId),
      this.quarantine.getTotalUsageBytesForUser(u.orgId, u.userId),
    ]);
    if (orgUsed + body.sizeBytes > ORG_QUOTA_BYTES)
      throw new PayloadTooLargeException("Organization storage quota exceeded");
    if (userUsed + body.sizeBytes > USER_QUOTA_BYTES)
      throw new PayloadTooLargeException("User storage quota exceeded");

    const result = await this.multipart.initiate(
      u.orgId,
      body.folder,
      body.fileName,
      body.mimeType,
      body.partCount,
    );

    /**
     * The quarantine row is written before the first part can be uploaded, not
     * after the last one lands. `isKeyBlocked` answers from this row, so the
     * key is unreachable for the whole window in which bytes exist at it —
     * beginning quarantine at completion leaves that window open.
     */
    const quarantineId = await this.quarantine.begin({
      orgId: u.orgId,
      storageKey: result.key,
      filename: body.fileName,
      mimeType: body.mimeType,
      fileSizeBytes: body.sizeBytes,
      sha256: "",
      uploadedBy: u.userId,
      idempotencyKey: result.uploadId,
    });

    this.audit.log({
      action: "file.multipart.initiate",
      userId: u.userId,
      orgId: u.orgId,
      metadata: {
        key: result.key,
        uploadId: result.uploadId,
        partCount: body.partCount,
        declaredSizeBytes: body.sizeBytes,
      },
    });

    return { ...result, quarantineId };
  }

  @Post("complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:files:manage")
  @Validate({ body: completeMultipartSchema })
  async complete(
    @Body() body: CompleteMultipartInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!this.storage.isConfigured())
      throw new ServiceUnavailableException("File storage is not available");
    this.assertOwnKey(body.key, u.orgId);

    const existing = await this.quarantine.findByIdempotencyKey(
      u.orgId,
      body.uploadId,
    );
    if (existing && existing.storageKey !== body.key)
      throw new ConflictException("Upload id does not match this storage key");
    if (existing && existing.status !== "pending_scan")
      return {
        quarantineId: existing.id,
        key: existing.storageKey,
        status: existing.status,
        replayed: true,
      };

    const outcome = await this.multipart.complete(
      u.orgId,
      body.key,
      body.uploadId,
      body.parts,
    );
    if (outcome === "unknown-upload")
      throw new NotFoundException("Multipart upload not found");

    const quarantineId =
      existing?.id ??
      (await this.quarantine.begin({
        orgId: u.orgId,
        storageKey: body.key,
        filename: body.key.split("/").pop() ?? "unknown",
        mimeType: "application/octet-stream",
        fileSizeBytes: 0,
        sha256: "",
        uploadedBy: u.userId,
        idempotencyKey: body.uploadId,
      }));

    await this.verifyStoredObject(u, body.key, quarantineId, existing?.mimeType);

    this.audit.log({
      action: "file.multipart.complete",
      userId: u.userId,
      orgId: u.orgId,
      metadata: {
        key: body.key,
        uploadId: body.uploadId,
        quarantineId,
        outcome,
      },
    });

    return {
      quarantineId,
      key: body.key,
      status: "pending_scan",
      replayed: outcome === "already-completed",
    };
  }

  @Post("abort")
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:files:manage")
  @Validate({ body: abortMultipartSchema })
  async abort(
    @Body() body: AbortMultipartInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!this.storage.isConfigured())
      throw new ServiceUnavailableException("File storage is not available");
    this.assertOwnKey(body.key, u.orgId);

    await this.multipart.abort(u.orgId, body.key, body.uploadId);

    /**
     * Cancellation has to clear both halves. Aborting the upload id leaves any
     * object a racing completion already assembled, and dropping the row
     * without the object leaves a blob nothing accounts for.
     */
    await this.storage.deleteFileIfPresent(u.orgId, body.key);
    const record = await this.quarantine.findByIdempotencyKey(
      u.orgId,
      body.uploadId,
    );
    if (record) await this.quarantine.softDelete(record.id);

    this.audit.log({
      action: "file.multipart.abort",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { key: body.key, uploadId: body.uploadId },
    });

    return { aborted: true };
  }

  private assertOwnKey(key: string, orgId: string): void {
    if (!this.storage.isValidFileKey(key))
      throw new BadRequestException("Invalid storage key");
    if (!key.startsWith(`${orgId}/`) || isForeignOrgKey(key, orgId))
      throw new BadRequestException("Key does not belong to this organization");
  }

  /**
   * The declared content type is the client's word and proves nothing, so the
   * assembled object is measured and sniffed here. A mismatch removes the
   * object and the row together rather than leaving a rejected file sitting at
   * a key someone can still ask for.
   */
  private async verifyStoredObject(
    u: CurrentUserContext,
    key: string,
    quarantineId: string,
    declaredMimeType: string | undefined,
  ): Promise<void> {
    const stored = await this.storage.describeObject(u.orgId, key);
    if (!stored) {
      await this.quarantine.softDelete(quarantineId);
      throw new ConflictException("Completed upload has no stored object");
    }

    if (stored.contentLength > MAX_MULTIPART_BYTES) {
      await this.discard(u.orgId, key, quarantineId);
      throw new PayloadTooLargeException("Stored object exceeds the size limit");
    }

    const orgUsed = await this.quarantine.getTotalUsageBytes(u.orgId);
    if (orgUsed + stored.contentLength > ORG_QUOTA_BYTES) {
      await this.discard(u.orgId, key, quarantineId);
      throw new PayloadTooLargeException("Organization storage quota exceeded");
    }

    const effectiveMime = declaredMimeType ?? stored.contentType;
    if (!ALLOWED_MULTIPART_TYPES.has(effectiveMime)) {
      await this.discard(u.orgId, key, quarantineId);
      throw new BadRequestException("MIME type not permitted for multipart upload");
    }

    const prefix = await this.storage.readObjectPrefix(
      u.orgId,
      key,
      SIGNATURE_SAMPLE_BYTES,
    );
    if (!prefix || !validateMagicBytes(prefix, effectiveMime)) {
      await this.discard(u.orgId, key, quarantineId);
      throw new UnprocessableEntityException(
        "File content does not match declared type",
      );
    }

    await this.quarantine.recordMeasuredObject(quarantineId, {
      fileSizeBytes: stored.contentLength,
      mimeType: effectiveMime,
    });
  }

  private async discard(
    orgId: string,
    key: string,
    quarantineId: string,
  ): Promise<void> {
    await this.storage.deleteFileIfPresent(orgId, key);
    await this.quarantine.softDelete(quarantineId);
  }
}
