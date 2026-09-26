import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbIndexingService } from "./kb-indexing.service";
import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";
import { StorageService } from "../../storage/storage.service";
import {
  extractDocumentText,
  isExtractableMime,
} from "../../../common/documents/extract-document-text.util";
import { streamToBuffer } from "./kb-chunk-utils";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";

export interface KbContentAdapter {
  readonly contentType: string;
  handle(orgId: string, contentId: number, signal?: AbortSignal): Promise<void>;
}

@Injectable()
export class KbPageAdapter implements KbContentAdapter {
  readonly contentType = "page";

  constructor(private readonly indexing: KbIndexingService) {}

  async handle(orgId: string, contentId: number, signal?: AbortSignal): Promise<void> {
    await this.indexing.indexPage(orgId, contentId, signal);
  }
}

@Injectable()
export class KbArticleAdapter implements KbContentAdapter {
  readonly contentType = "article";

  constructor(private readonly indexing: KbIndexingService) {}

  async handle(orgId: string, contentId: number, signal?: AbortSignal): Promise<void> {
    await this.indexing.indexArticle(orgId, contentId, signal);
  }
}

@Injectable()
export class KbSourceAdapter implements KbContentAdapter {
  readonly contentType = "source";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly attachmentIndexing: KbAttachmentIndexingService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async handle(orgId: string, sourceId: number, _signal?: AbortSignal): Promise<void> {
    const source = await this.db.query.kbSources.findFirst({
      where: and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)),
      columns: {
        id: true,
        kind: true,
        noteText: true,
        fileKey: true,
        mimeType: true,
        deletedAt: true,
      },
    });
    if (!source || source.deletedAt) return;

    const text = await this.resolveText(orgId, source);
    if (text === null) {
      await this.settle(orgId, sourceId, 0, "Unsupported file type");
      return;
    }

    const chunks = await this.attachmentIndexing.indexSource(orgId, sourceId, text);
    await this.settle(orgId, sourceId, chunks, "No indexable text");
  }

  private async resolveText(
    orgId: string,
    source: { kind: string; noteText: string | null; fileKey: string | null; mimeType: string | null },
  ): Promise<string | null> {
    if (source.kind === "note") return source.noteText ?? "";
    if (!source.fileKey || !source.mimeType || !isExtractableMime(source.mimeType)) return null;

    const { body } = await this.storage.getFileStream(
      orgId,
      source.fileKey,
      this.config.R2_KB_BUCKET_NAME,
    );
    const buffer = await streamToBuffer(body);
    return extractDocumentText(buffer, source.mimeType);
  }

  private async settle(
    orgId: string,
    sourceId: number,
    chunks: number,
    emptyReason: string,
  ): Promise<void> {
    await this.db
      .update(kbSources)
      .set({
        status: chunks > 0 ? "ready" : "failed",
        chunkCount: chunks,
        errorMessage: chunks > 0 ? null : emptyReason,
      })
      .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)));
  }
}

@Injectable()
export class KbAttachmentAdapter implements KbContentAdapter {
  readonly contentType = "attachment";

  constructor(private readonly attachmentIndexing: KbAttachmentIndexingService) {}

  async handle(orgId: string, contentId: number, _signal?: AbortSignal): Promise<void> {
    await this.attachmentIndexing.indexAttachment(orgId, contentId);
  }
}

@Injectable()
export class KbContentAdapterRegistry {
  private readonly adapters = new Map<string, KbContentAdapter>();

  register(adapter: KbContentAdapter): void {
    this.adapters.set(adapter.contentType, adapter);
  }

  get(contentType: string): KbContentAdapter | undefined {
    return this.adapters.get(contentType);
  }
}
