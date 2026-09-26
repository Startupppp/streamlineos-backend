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
import { and, desc, eq, isNull } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { kbSources, outboxEvents } from "../../../db/schema";
import { StorageService } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import {
  isExtractableMime,
  extractAttachmentText,
} from "../retrieval/kb-attachment-extract.util";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { TenantTx } from "../../../db/drizzle.types";
import { KbAccessService } from "../core/kb-access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import {
  KbIndexedBytesQuotaService,
  kbSourceIndexedBytes,
} from "../core/kb-indexed-bytes-quota.service";
import type {
  CreateKbSourceNoteInput,
  KbIngestionState,
  KbArticleIngestionStatus,
  KbPageIngestionStatus,
  KbSourcesListQuery,
} from "./dto/kb-sources.schemas";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
  createdById: string | null;
  createdAt: Date;
}

const SOURCE_LIST_COLUMNS = {
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
  createdById: kbSources.createdById,
  createdAt: kbSources.createdAt,
};

type OutboxDeliveryState = (typeof outboxEvents.$inferSelect)["deliveryState"];

const INGESTION_STATE_BY_DELIVERY: Record<
  OutboxDeliveryState,
  KbIngestionState
> = {
  PENDING: "pending",
  IN_FLIGHT: "in_flight",
  DELIVERED: "indexed",
  DEAD: "failed",
  SUPPRESSED: "suppressed",
};

function ingestionStateOf(delivery: OutboxDeliveryState): KbIngestionState {
  return INGESTION_STATE_BY_DELIVERY[delivery];
}

@Injectable()
export class KbSourcesService {
  private readonly logger = new Logger(KbSourcesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly attachmentIndexing: KbAttachmentIndexingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: KbAccessService,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly quota: KbIndexedBytesQuotaService,
  ) {}

  async list(
    orgId: string,
    query: KbSourcesListQuery,
  ): Promise<CursorPage<KbSourceListItem>> {
    const position = decodeCursor(query.cursor);
    const after = position
      ? keysetBeforeMicros(kbSources.createdAt, kbSources.id, {
          sortValue: String(position.sortValue),
          id: Number(position.id),
        })
      : undefined;

    const rows = await this.db
      .select({
        ...SOURCE_LIST_COLUMNS,
        createdAtMicros: microsecondCursorValue(kbSources.createdAt),
      })
      .from(kbSources)
      .where(
        and(
          eq(kbSources.orgId, orgId),
          isNull(kbSources.deletedAt),
          after,
          query.kind !== undefined ? eq(kbSources.kind, query.kind) : undefined,
          query.createdById !== undefined ? eq(kbSources.createdById, query.createdById) : undefined,
        ),
      )
      .orderBy(desc(kbSources.createdAt), desc(kbSources.id))
      .limit(query.limit + 1);

    const cursorValues = new Map(rows.map((r) => [r.id, r.createdAtMicros]));

    const items: KbSourceListItem[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      mimeType: r.mimeType,
      fileSize: r.fileSize,
      fileUrl: r.fileUrl,
      status: r.status,
      chunkCount: r.chunkCount,
      errorMessage: r.errorMessage,
      spaceId: r.spaceId,
      createdById: r.createdById,
      createdAt: r.createdAt,
    }));

    return buildCursorPage(items, query.limit, (row) => ({
      sortValue: cursorValues.get(row.id) ?? row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async get(orgId: string, sourceId: number): Promise<KbSourceListItem> {
    const [row] = await this.db
      .select(SOURCE_LIST_COLUMNS)
      .from(kbSources)
      .where(
        and(
          eq(kbSources.id, sourceId),
          eq(kbSources.orgId, orgId),
          isNull(kbSources.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Source not found");
    return row;
  }

  async pageIngestionStatus(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<KbPageIngestionStatus> {
    await this.auth.assertPageAccess(user, pageId, "view");
    return {
      pageId,
      ...(await this.ingestionStatusFor(user.orgId, "kb_page", pageId)),
    };
  }

  async articleIngestionStatus(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<KbArticleIngestionStatus> {
    await this.access.assertArticleViewable(user, articleId);
    return {
      articleId,
      ...(await this.ingestionStatusFor(user.orgId, "kb_article", articleId)),
    };
  }

  private async ingestionStatusFor(
    orgId: string,
    aggregateType: string,
    aggregateId: number,
  ): Promise<Omit<KbPageIngestionStatus, "pageId">> {
    const [event] = await this.db
      .select({
        deliveryState: outboxEvents.deliveryState,
        retryCount: outboxEvents.retryCount,
        occurredAt: outboxEvents.occurredAt,
        publishedAt: outboxEvents.publishedAt,
        deadLetteredAt: outboxEvents.deadLetteredAt,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, orgId),
          eq(outboxEvents.aggregateType, aggregateType),
          eq(outboxEvents.aggregateId, String(aggregateId)),
          eq(outboxEvents.eventType, "kb.content.index"),
        ),
      )
      .orderBy(desc(outboxEvents.aggregateVersion))
      .limit(1);

    if (!event)
      return {
        state: "unknown",
        retryCount: 0,
        occurredAt: null,
        publishedAt: null,
        deadLetteredAt: null,
      };

    return {
      state: ingestionStateOf(event.deliveryState),
      retryCount: event.retryCount,
      occurredAt: event.occurredAt,
      publishedAt: event.publishedAt,
      deadLetteredAt: event.deadLetteredAt,
    };
  }

  async createNote(
    user: CurrentUserContext,
    input: CreateKbSourceNoteInput,
  ): Promise<typeof kbSources.$inferSelect> {
    const byteSize = Buffer.byteLength(input.text, "utf8");
    const { row, deferred } = await runInTenantTransaction(
      this.db,
      async (tx) => {
        await this.quota.reserve(tx, user.orgId, byteSize);
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
        const registered = registerAfterCommit(async () => {
          await this.processText(user.orgId, inserted.id, input.text, byteSize);
        });
        return { row: inserted, deferred: registered };
      },
      { orgId: user.orgId },
    );
    if (!deferred)
      await this.processText(user.orgId, row.id, input.text, byteSize);
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

    if (!isAllowedType)
      throw new BadRequestException(
        "Unsupported file type. Upload PDF, DOCX, TXT, MD or CSV.",
      );

    if (buffer.length > 25 * 1024 * 1024)
      throw new BadRequestException("File exceeds the 25 MB limit");

    if (!mimetype.startsWith("text/") && !validateMagicBytes(buffer, mimetype))
      throw new BadRequestException(
        "File content does not match declared type",
      );

    const kbBucket = this.config.R2_KB_BUCKET_NAME;
    const result = await this.storage.uploadFile(
      user.orgId,
      buffer,
      `kb-sources/${user.orgId}`,
      originalname,
      mimetype,
      kbBucket,
    );

    const byteSize = file.size;
    const { row, deferred } = await runInTenantTransaction(
      this.db,
      async (tx) => {
        await this.quota.reserve(tx, user.orgId, byteSize);
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
        const registered = registerAfterCommit(async () => {
          await this.processFile(
            user.orgId,
            inserted.id,
            buffer,
            mimetype,
            byteSize,
          );
        });
        return { row: inserted, deferred: registered };
      },
      { orgId: user.orgId },
    );
    if (!deferred)
      await this.processFile(user.orgId, row.id, buffer, mimetype, byteSize);
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
    await this.quota.release(orgId, kbSourceIndexedBytes(row));
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

  private async emitIndexEvent(
    tx: TenantTx,
    orgId: string,
    sourceId: number,
  ): Promise<void> {
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

  private async markFailed(
    orgId: string,
    sourceId: number,
    message: string,
  ): Promise<void> {
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
    bytes: number,
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
      if (count === 0) await this.quota.release(orgId, bytes);
    } catch (err) {
      this.logger.error(`Failed to index source ${sourceId}: ${String(err)}`);
      await this.markFailed(orgId, sourceId, "Indexing failed");
      await this.quota.release(orgId, bytes);
    }
  }

  private async processFile(
    orgId: string,
    sourceId: number,
    buffer: Buffer,
    mimeType: string,
    bytes: number,
  ): Promise<void> {
    if (!isExtractableMime(mimeType)) {
      await this.markFailed(orgId, sourceId, "Unsupported file type");
      await this.quota.release(orgId, bytes);
      return;
    }
    try {
      const text = await extractAttachmentText(buffer, mimeType);
      await this.processText(orgId, sourceId, text, bytes);
    } catch (err) {
      this.logger.error(
        `Failed to extract text from source ${sourceId}: ${String(err)}`,
      );
      await this.markFailed(orgId, sourceId, "Could not read file");
      await this.quota.release(orgId, bytes);
    }
  }
}
