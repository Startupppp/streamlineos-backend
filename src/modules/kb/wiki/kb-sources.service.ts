import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
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
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { TenantTx } from "../../../db/drizzle.types";
import type { CreateKbSourceNoteInput, KbSourcesListQuery } from "./dto/kb-sources.schemas";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";



/**
 * Why every source insert also writes an outbox event.
 *
 * Ingestion used to be driven ONLY by `registerAfterCommit`, which the interceptor fires as
 * `void run().catch(...)` — detached, after the response, with no shutdown drain. A deploy
 * between the commit and the drain left `kb_sources.status = 'processing'` with no lease, no
 * retry and no dead letter to reclaim it: the UI polls that row forever, `/kb/ask` ignores the
 * document, and the only recourse re-charges embedding credits. Pages and articles never had
 * that problem because they emit `kb.content.index` in the same transaction as the row and the
 * relay retries until the consumer succeeds; sources now do the same. The after-commit hook
 * stays as the fast path, and the event is the durable floor beneath it.
 *
 * The two do NOT double-charge: `indexSource` hashes the source text and skips the embed when
 * the stored chunks already match, so whichever runs second finds the work done and pays
 * nothing. That short-circuit is what makes emitting both safe.
 */
export interface KbSourceListItem {
  id: number;
  kind: string;
  title: string;
  mimeType: string | null;
  fileSize: number | null;
  fileUrl: string | null;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  spaceId: number | null;
  createdAt: Date;
}

@Injectable()
export class KbSourcesService {
  private readonly logger = new Logger(KbSourcesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly attachmentIndexing: KbAttachmentIndexingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * This used to be `.limit(100)` and nothing else — no cursor, no page, no signal. A
   * tenant that uploaded a 101st source could not reach it from any client, and the
   * response looked exactly like a complete list, so nothing surfaced the loss. A hard cap
   * with no way past it is silent truncation, not a page size.
   *
   * Keyset rather than offset, because this list is written to while it is read: a source
   * finishing ingestion mid-scroll re-sorts an offset window and the reader sees a
   * duplicate or misses a row. `(created_at DESC, id DESC)` is the order, and both halves
   * are in the cursor — `created_at` carries no uniqueness, so two uploads in the same
   * millisecond would otherwise straddle a page boundary permanently.
   *
   * `limit + 1` is fetched so `hasMore` is known without a second COUNT, and the next
   * cursor is taken from the last row KEPT rather than the discarded sentinel: pointing an
   * exclusive bound at the sentinel skips that row for good.
   */
  async list(orgId: string, query: KbSourcesListQuery): Promise<CursorPage<KbSourceListItem>> {
    const position = decodeCursor(query.cursor);
    const after = position
      ? or(
          lt(kbSources.createdAt, new Date(position.sortValue)),
          and(
            eq(kbSources.createdAt, new Date(position.sortValue)),
            lt(kbSources.id, Number(position.id)),
          ),
        )
      : undefined;

    const rows = await this.db
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
      .where(and(eq(kbSources.orgId, orgId), isNull(kbSources.deletedAt), after))
      .orderBy(desc(kbSources.createdAt), desc(kbSources.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async createNote(
    user: CurrentUserContext,
    input: CreateKbSourceNoteInput,
  ): Promise<typeof kbSources.$inferSelect> {
    // `this.db.transaction` rather than `runInTenantTransaction`: every caller is a request, so
    // the ambient tenant transaction is already open and this becomes a savepoint inside it —
    // which is what makes the row and its event atomic. It is also the idiom the rest of the
    // KB write path uses.
    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
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
      if (!inserted) throw new InternalServerErrorException("Insert failed");
      await this.emitIndexEvent(tx, user.orgId, inserted.id);
      return inserted;
    });
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
    const result = await this.storage.uploadFile(
      user.orgId,
      buffer,
      `kb-sources/${user.orgId}`,
      originalname,
      mimetype,
      kbBucket,
    );

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(kbSources)
        .values({
          orgId: user.orgId,
          spaceId: spaceId ?? null,
          kind: "file",
          title: originalname,
          fileKey: result.key,
          fileUrl: result.key,
          mimeType: mimetype,
          fileSize: file.size,
          status: "processing",
          createdById: user.userId,
        })
        .returning();
      if (!inserted) throw new InternalServerErrorException("Insert failed");
      await this.emitIndexEvent(tx, user.orgId, inserted.id);
      return inserted;
    });
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
        await this.storage.deleteFile(
          orgId,
          row.fileKey,
          this.config.R2_KB_BUCKET_NAME,
        );
      } catch (err: unknown) {
        this.logger.warn(
          `KB source ${id} soft-deleted but binary "${row.fileKey}" could not be deleted from storage: ${String(err)}`,
        );
      }
    }
    return { success: true };
  }

  /** The durable half of ingestion, committed with the row so a crash cannot lose it. */
  private async emitIndexEvent(tx: TenantTx, orgId: string, sourceId: number): Promise<void> {
    await OutboxWriter.emit(tx, {
      eventId: randomUUID(),
      organizationId: orgId,
      aggregateType: "kb_source",
      aggregateId: String(sourceId),
      aggregateVersion: Date.now(),
      eventType: "kb.content.index",
      payload: { contentType: "source", contentId: sourceId },
      occurredAt: new Date(),
    });
  }

  /** Recording a failure must not itself fail silently (backend CLAUDE.md §4). */
  private async markFailed(orgId: string, sourceId: number, message: string): Promise<void> {
    try {
      await this.db
        .update(kbSources)
        .set({ status: "failed", errorMessage: message })
        .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)));
    } catch (err) {
      this.logger.error(
        `KB source ${sourceId} failed to index AND could not be marked failed: ${String(err)}`,
      );
    }
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
      await this.markFailed(orgId, sourceId, "Indexing failed");
    }
  }

  private async processFile(
    orgId: string,
    sourceId: number,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    if (!isExtractableMime(mimeType)) {
      await this.markFailed(orgId, sourceId, "Unsupported file type");
      return;
    }
    try {
      const text = await extractAttachmentText(buffer, mimeType);
      await this.processText(orgId, sourceId, text);
    } catch (err) {
      this.logger.error(
        `Failed to extract text from source ${sourceId}: ${String(err)}`,
      );
      await this.markFailed(orgId, sourceId, "Could not read file");
    }
  }
}
