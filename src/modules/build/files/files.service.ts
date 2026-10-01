import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { projectAttachments } from "../../../db/schema/build/project-attachments";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertCanModifyAuthoredRecord, assertProjectAccess, escapeLike } from "../core";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  buildCursorPage,
  decodeTimestampCursor,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { StorageService } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import type { UploadFileInput, ListFilesQuery } from "./dto/files.schemas";

const DEFAULT_LIMIT = 25;
const SIGNED_URL_TTL = 120;

function decodeBase64(value: string): Buffer {
  const payload =
    value.includes(",") && value.trimStart().startsWith("data:")
      ? value.slice(value.indexOf(",") + 1)
      : value;
  const cleaned = payload.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0)
    throw new BadRequestException("contentBase64 is not valid base64");
  return Buffer.from(cleaned, "base64");
}

const FILE_VIEW_COLUMNS = {
  id: projectAttachments.id,
  orgId: projectAttachments.orgId,
  projectId: projectAttachments.projectId,
  uploadedByMembershipId: projectAttachments.uploadedByMembershipId,
  fileName: projectAttachments.fileName,
  mimeType: projectAttachments.mimeType,
  sizeBytes: projectAttachments.sizeBytes,
  deletedAt: projectAttachments.deletedAt,
} as const;

@Injectable()
export class FilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  private async loadFile(orgId: string, projectId: number, fileId: number) {
    const [row] = await this.db
      .select({
        id: projectAttachments.id,
        uploadedByMembershipId: projectAttachments.uploadedByMembershipId,
        storageKey: projectAttachments.storageKey,
      })
      .from(projectAttachments)
      .where(
        and(
          eq(projectAttachments.id, fileId),
          eq(projectAttachments.orgId, orgId),
          eq(projectAttachments.projectId, projectId),
          isNull(projectAttachments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("File not found");
    return row;
  }

  async listFiles(u: CurrentUserContext, projectId: number, query: ListFilesQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const position = decodeTimestampCursor(query.cursor ?? null);

    const rows = await this.db
      .select({
        ...FILE_VIEW_COLUMNS,
        createdAt: microsecondCursorValue(projectAttachments.createdAt),
      })
      .from(projectAttachments)
      .where(
        and(
          eq(projectAttachments.orgId, u.orgId),
          eq(projectAttachments.projectId, projectId),
          isNull(projectAttachments.deletedAt),
          query.q ? ilike(projectAttachments.fileName, `${escapeLike(query.q)}%`) : undefined,
          position
            ? keysetBeforeMicros(projectAttachments.createdAt, projectAttachments.id, position)
            : undefined,
        ),
      )
      .orderBy(desc(projectAttachments.createdAt), desc(projectAttachments.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt,
      id: String(row.id),
    }));
  }

  async uploadFile(u: CurrentUserContext, projectId: number, input: UploadFileInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      throw new ForbiddenException("No active membership found");

    if (!this.storage.isConfigured())
      throw new ServiceUnavailableException("File storage is not available");

    const buffer = decodeBase64(input.contentBase64);
    if (buffer.length === 0)
      throw new BadRequestException("The file is empty");
    if (buffer.length > 2 * 1024 * 1024)
      throw new BadRequestException("The file exceeds the 2 MB limit");
    if (!validateMagicBytes(buffer, input.mimeType))
      throw new BadRequestException(`The file contents do not match the declared type ${input.mimeType}`);

    const uploaded = await this.storage.uploadFile(
      u.orgId,
      buffer,
      `build/${projectId}/files`,
      input.fileName,
      input.mimeType,
    );

    const [file] = await this.db
      .insert(projectAttachments)
      .values({
        orgId: u.orgId,
        projectId,
        uploadedByMembershipId: membershipId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: buffer.length,
        storageKey: uploaded.key,
      })
      .returning({ ...FILE_VIEW_COLUMNS, createdAt: projectAttachments.createdAt });

    if (!file) throw new NotFoundException("Failed to create file record");

    this.audit.log({
      action: "project_file.uploaded",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_file",
      resourceId: String(file.id),
      metadata: { projectId, fileId: file.id, fileName: input.fileName },
    });

    return file;
  }

  async getSignedUrl(u: CurrentUserContext, projectId: number, fileId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const file = await this.loadFile(u.orgId, projectId, fileId);
    const url = await this.storage.getFileUrl(u.orgId, file.storageKey, SIGNED_URL_TTL);
    return { url, expiresIn: SIGNED_URL_TTL };
  }

  async softDeleteFile(u: CurrentUserContext, projectId: number, fileId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const file = await this.loadFile(u.orgId, projectId, fileId);
    await assertCanModifyAuthoredRecord(
      this.access,
      u,
      { membershipId: file.uploadedByMembershipId },
      "build:files:manage",
      "You can only delete files you uploaded",
    );
    await this.db
      .update(projectAttachments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectAttachments.id, fileId),
          eq(projectAttachments.orgId, u.orgId),
          eq(projectAttachments.projectId, projectId),
          isNull(projectAttachments.deletedAt),
        ),
      );
    this.audit.log({
      action: "project_file.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_file",
      resourceId: String(fileId),
      metadata: { projectId, fileId },
    });
  }
}
