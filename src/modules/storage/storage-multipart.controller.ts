import {
  BadRequestException,
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
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
import {
  initiateMultipartSchema,
  completeMultipartSchema,
  abortMultipartSchema,
  type InitiateMultipartInput,
  type CompleteMultipartInput,
  type AbortMultipartInput,
} from "./dto/storage-multipart.schemas";

const ORG_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const USER_QUOTA_BYTES = 500 * 1024 * 1024;

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

    const [orgUsed, userUsed] = await Promise.all([
      this.quarantine.getTotalUsageBytes(u.orgId),
      this.quarantine.getTotalUsageBytesForUser(u.orgId, u.userId),
    ]);
    if (orgUsed >= ORG_QUOTA_BYTES)
      throw new BadRequestException("Organization storage quota exceeded");
    if (userUsed >= USER_QUOTA_BYTES)
      throw new BadRequestException("User storage quota exceeded");

    const result = await this.multipart.initiate(
      u.orgId,
      body.folder,
      body.fileName,
      body.mimeType,
      body.partCount,
    );

    this.audit.log({
      action: "file.multipart.initiate",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { key: result.key, uploadId: result.uploadId, partCount: body.partCount },
    });

    return result;
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
    if (!this.storage.isValidFileKey(body.key))
      throw new BadRequestException("Invalid storage key");
    if (!body.key.startsWith(`${u.orgId}/`))
      throw new BadRequestException("Key does not belong to this organization");

    await this.multipart.complete(u.orgId, body.key, body.uploadId, body.parts);

    const quarantineId = await this.quarantine.begin({
      orgId: u.orgId,
      storageKey: body.key,
      filename: body.key.split("/").pop() ?? "unknown",
      mimeType: "application/octet-stream",
      fileSizeBytes: 0,
      sha256: "",
      uploadedBy: u.userId,
    });
    await this.quarantine.markClean(quarantineId);

    this.audit.log({
      action: "file.multipart.complete",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { key: body.key, uploadId: body.uploadId, quarantineId },
    });

    return { quarantineId, key: body.key, status: "clean" };
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
    if (!this.storage.isValidFileKey(body.key))
      throw new BadRequestException("Invalid storage key");
    if (!body.key.startsWith(`${u.orgId}/`))
      throw new BadRequestException("Key does not belong to this organization");

    await this.multipart.abort(u.orgId, body.key, body.uploadId);

    this.audit.log({
      action: "file.multipart.abort",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { key: body.key, uploadId: body.uploadId },
    });

    return { aborted: true };
  }
}
