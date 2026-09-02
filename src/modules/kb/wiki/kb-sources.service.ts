import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { kbSources } from "../../../db/schema";
import { StorageService } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import {
  isExtractableMime,
  extractAttachmentText,
} from "../retrieval/kb-attachment-extract.util";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import type { CreateKbSourceNoteInput } from "./dto/kb-sources.schemas";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const MAX_SOURCES = 100;

@Injectable()
export class KbSourcesService {
  private readonly logger = new Logger(KbSourcesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly attachmentIndexing: KbAttachmentIndexingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(orgId: string) {
    return this.db
      .select({
        id: kbSources.id,
        kind: kbSources.kind,
        title: kbSources.title,
        mimeType: kbSources.mimeType,
        fileSize: kbSources.fileSize,
        fileUrl: kbSources.fileUrl,
        status: kbSources.status,
        chunkCount: kbSources.chunkCount,
        errorMessage: kbSources.errorMessage,
        spaceId: kbSources.spaceId,
        createdAt: kbSources.createdAt,
      })
      .from(kbSources)
      .where(and(eq(kbSources.orgId, orgId), isNull(kbSources.deletedAt)))
      .orderBy(desc(kbSources.createdAt))
      .limit(MAX_SOURCES);
  }

  async createNote(
    user: CurrentUserContext,
    input: CreateKbSourceNoteInput,
  ): Promise<typeof kbSources.$inferSelect> {
    const rows = await this.db
      .insert(kbSources)
      .values({
        orgId: user.orgId,
        spaceId: input.spaceId ?? null,
        kind: "note",
        title: input.title,
        noteText: input.text,
        status: "processing",
        createdById: user.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new InternalServerErrorException("Insert failed");
    }
    const textDeferred = registerAfterCommit(async () => {
      await this.processText(user.orgId, row.id, input.text);
    });
    if (!textDeferred) await this.processText(user.orgId, row.id, input.text);
    return row;
  }

  async createFile(
    user: CurrentUserContext,
    file: Express.Multer.File,
    spaceId?: number | null,
  ): Promise<typeof kbSources.$inferSelect> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not available");
    }

    const { mimetype, buffer, originalname } = file;

    const isAllowedType =
      mimetype === "application/pdf" ||
      mimetype === DOCX_MIME ||
      mimetype.startsWith("text/");

    if (!isAllowedType) {
      throw new BadRequestException(
        "Unsupported file type. Upload PDF, DOCX, TXT, MD or CSV.",
      );
    }

    if (buffer.length > 25 * 1024 * 1024) {
      throw new BadRequestException("File exceeds the 25 MB limit");
    }

    if (
      !mimetype.startsWith("text/") &&
      !validateMagicBytes(buffer, mimetype)
    ) {
      throw new BadRequestException(
        "File content does not match declared type",
      );
    }

    const kbBucket = this.config.R2_KB_BUCKET_NAME;
    const kbPublicUrl = this.config.R2_KB_PUBLIC_URL;
    const useKbBucket = Boolean(kbBucket && kbPublicUrl);
    const result = await this.storage.uploadFile(
      user.orgId,
      buffer,
      `kb-sources/${user.orgId}`,
      originalname,
      mimetype,
      useKbBucket ? kbBucket : undefined,
      useKbBucket ? kbPublicUrl : undefined,
    );

    const rows = await this.db
      .insert(kbSources)
      .values({
        orgId: user.orgId,
        spaceId: spaceId ?? null,
        kind: "file",
        title: originalname,
        fileKey: result.key,
        fileUrl: result.url,
        mimeType: mimetype,
        fileSize: file.size,
        status: "processing",
        createdById: user.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new InternalServerErrorException("Insert failed");
    }
    const fileDeferred = registerAfterCommit(async () => {
      await this.processFile(user.orgId, row.id, buffer, mimetype);
    });
    if (!fileDeferred)
      await this.processFile(user.orgId, row.id, buffer, mimetype);
    return row;
  }

  async remove(orgId: string, id: number): Promise<{ success: boolean }> {
    const rows = await this.db
      .update(kbSources)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(kbSources.id, id),
          eq(kbSources.orgId, orgId),
          isNull(kbSources.deletedAt),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new NotFoundException("Source not found");
    }
    await this.attachmentIndexing.removeSourceChunks(orgId, id);
    const row = rows[0];
    if (row.kind === "file" && row.fileKey) {
      try {
        await this.storage.deleteFile(orgId, row.fileKey);
      } catch (err: unknown) {
        this.logger.warn(
          `KB source ${id} soft-deleted but binary "${row.fileKey}" could not be deleted from storage: ${String(err)}`,
        );
      }
    }
    return { success: true };
  }

  private async processText(
    orgId: string,
    sourceId: number,
    text: string,
  ): Promise<void> {
    try {
      const count = await this.attachmentIndexing.indexSource(
        orgId,
        sourceId,
        text,
      );
      await this.db
        .update(kbSources)
        .set({
          status: count > 0 ? "ready" : "failed",
          chunkCount: count,
          errorMessage: count > 0 ? null : "No indexable text",
        })
        .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)));
    } catch (err) {
      this.logger.error(`Failed to index source ${sourceId}: ${String(err)}`);
      await this.db
        .update(kbSources)
        .set({ status: "failed", errorMessage: "Indexing failed" })
        .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)))
        .catch(() => undefined);
    }
  }

  private async processFile(
    orgId: string,
    sourceId: number,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    if (!isExtractableMime(mimeType)) {
      await this.db
        .update(kbSources)
        .set({ status: "failed", errorMessage: "Unsupported file type" })
        .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)))
        .catch(() => undefined);
      return;
    }
    try {
      const text = await extractAttachmentText(buffer, mimeType);
      await this.processText(orgId, sourceId, text);
    } catch (err) {
      this.logger.error(
        `Failed to extract text from source ${sourceId}: ${String(err)}`,
      );
      await this.db
        .update(kbSources)
        .set({ status: "failed", errorMessage: "Could not read file" })
        .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)))
        .catch(() => undefined);
    }
  }
}
