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
      columns: { id: true, kind: true, noteText: true, fileKey: true, mimeType: true, status: true },
    });
    if (!source || source.status !== "ready") return;

    if (source.kind === "note" && source.noteText) {
      await this.attachmentIndexing.indexSource(orgId, sourceId, source.noteText);
      return;
    }

    if (source.fileKey && source.mimeType && isExtractableMime(source.mimeType)) {
      const { body } = await this.storage.getFileStream(
        orgId,
        source.fileKey,
        this.config.R2_KB_BUCKET_NAME,
      );
      const buffer = await streamToBuffer(body);
      const text = await extractAttachmentText(buffer, source.mimeType);
      if (text.trim()) await this.attachmentIndexing.indexSource(orgId, sourceId, text);
    }
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
