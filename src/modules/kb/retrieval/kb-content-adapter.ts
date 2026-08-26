import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbIndexingService } from "./kb-indexing.service";
import { StorageService } from "../../storage/storage.service";
import { extractAttachmentText, isExtractableMime } from "./kb-attachment-extract.util";
import { Readable } from "stream";

export interface KbContentAdapter {
  readonly contentType: string;
  handle(orgId: string, contentId: number): Promise<void>;
}

@Injectable()
export class KbPageAdapter implements KbContentAdapter {
  readonly contentType = "page";

  constructor(private readonly indexing: KbIndexingService) {}

  async handle(orgId: string, contentId: number): Promise<void> {
    await this.indexing.indexPage(orgId, contentId);
  }
}

@Injectable()
export class KbArticleAdapter implements KbContentAdapter {
  readonly contentType = "article";

  constructor(private readonly indexing: KbIndexingService) {}

  async handle(orgId: string, contentId: number): Promise<void> {
    await this.indexing.indexArticle(orgId, contentId);
  }
}

@Injectable()
export class KbSourceAdapter implements KbContentAdapter {
  readonly contentType = "source";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly indexing: KbIndexingService,
    private readonly storage: StorageService,
  ) {}

  async handle(orgId: string, sourceId: number): Promise<void> {
    const source = await this.db.query.kbSources.findFirst({
      where: and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)),
      columns: { id: true, kind: true, noteText: true, fileKey: true, mimeType: true, status: true },
    });
    if (!source || source.status !== "ready") return;

    if (source.kind === "note" && source.noteText) {
      await this.indexing.indexSource(orgId, sourceId, source.noteText);
      return;
    }

    if (source.fileKey && source.mimeType && isExtractableMime(source.mimeType)) {
      const { body } = await this.storage.getFileStream(source.fileKey);
      const buffer = await streamToBuffer(body);
      const text = await extractAttachmentText(buffer, source.mimeType);
      if (text.trim()) await this.indexing.indexSource(orgId, sourceId, text);
    }
  }
}

@Injectable()
export class KbAttachmentAdapter implements KbContentAdapter {
  readonly contentType = "attachment";

  constructor(private readonly indexing: KbIndexingService) {}

  async handle(orgId: string, contentId: number): Promise<void> {
    await this.indexing.indexAttachment(orgId, contentId);
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
