import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbIndexingService } from "./kb-indexing.service";
import { KbAttachmentIndexingService } from "./kb-attachment-indexing.service";
import { StorageService } from "../../storage/storage.service";
import { extractAttachmentText, isExtractableMime } from "./kb-attachment-extract.util";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { Readable } from "stream";

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

/**
 * `kbSources.fileKey` names an object `KbSourcesService.create` uploaded with the
 * R2_KB_BUCKET_NAME override, so the read back has to carry the same override.
 * Without it the GET addresses the default bucket and 404s wherever the two
 * buckets differ, and the source silently indexes to nothing.
 *
 * This adapter owns the source's terminal status, and that is a change: it used to return
 * early unless the row already said `ready`, which made it a re-index path only. A source is
 * created `processing`, so the durable `kb.content.index` event now emitted alongside the
 * insert would have been a no-op under the old guard — the event would drain, do nothing, and
 * leave the row `processing` forever, which is the exact defect it was added to close. It
 * therefore accepts any live row and writes the outcome, so a lost after-commit hook is healed
 * by the relay instead of stranding the upload.
 */
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
    // A deleted source has had its chunks removed by `KbSourcesService.remove`; re-indexing it
    // would put them back. Everything else is fair game, whatever status it currently carries.
    // Truthiness, not `!== null`: a timestamp is truthy and an absent column must read as live.
    if (!source || source.deletedAt) return;

    const text = await this.resolveText(orgId, source);
    if (text === null) {
      await this.settle(orgId, sourceId, 0, "Unsupported file type");
      return;
    }

    // A throw here is what the outbox needs: the event is retried, and it dead-letters only
    // after `shouldDeadLetter`. Swallowing it would report success for an unindexed source.
    const chunks = await this.attachmentIndexing.indexSource(orgId, sourceId, text);
    await this.settle(orgId, sourceId, chunks, "No indexable text");
  }

  /** `null` means "this source can never be indexed", as distinct from "it has no text". */
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
    return extractAttachmentText(buffer, source.mimeType);
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

function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
