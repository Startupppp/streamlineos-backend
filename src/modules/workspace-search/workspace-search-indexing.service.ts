import { createHash } from "crypto";
import { Inject, Injectable, NotImplementedException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { workspaceSearchChunks } from "../../db/schema";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import type { WorkspaceEntityTypeParam } from "./dto/workspace-search.schemas";

export interface UpsertChunkParams {
  orgId: string;
  entityType: WorkspaceEntityTypeParam;
  entityId: number;
  title: string;
  content: string;
  urlPath: string;
}

@Injectable()
export class WorkspaceSearchIndexingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
  ) {}

  async upsertChunk(params: UpsertChunkParams): Promise<void> {
    const hash = createHash("sha256")
      .update(`${params.title}\n${params.content}`)
      .digest("hex");

    const existing = await this.db.query.workspaceSearchChunks.findFirst({
      where: and(
        eq(workspaceSearchChunks.orgId, params.orgId),
        eq(workspaceSearchChunks.entityType, params.entityType),
        eq(workspaceSearchChunks.entityId, params.entityId),
      ),
      columns: { contentHash: true },
    });

    if (existing?.contentHash === hash) return;

    let embeddingVec: number[] | undefined;
    let embeddingModel: string | undefined;

    if (this.embeddings.isConfigured()) {
      try {
        embeddingVec = await this.embeddings.embedQuery(`${params.title}\n${params.content}`);
        embeddingModel = "text-embedding-3-small";
      } catch {
        // embedding failure is non-fatal; chunk is still indexed via FTS
      }
    }

    const values = {
      orgId: params.orgId,
      entityType: params.entityType,
      entityId: params.entityId,
      title: params.title,
      content: params.content,
      urlPath: params.urlPath,
      contentHash: hash,
      updatedAt: new Date(),
      ...(embeddingVec !== undefined ? { embedding: embeddingVec, embeddingModel } : {}),
    };

    await this.db
      .insert(workspaceSearchChunks)
      .values(values)
      .onConflictDoUpdate({
        target: [
          workspaceSearchChunks.orgId,
          workspaceSearchChunks.entityType,
          workspaceSearchChunks.entityId,
        ],
        set: {
          title: sql`excluded.title`,
          content: sql`excluded.content`,
          urlPath: sql`excluded.url_path`,
          contentHash: sql`excluded.content_hash`,
          embedding: sql`excluded.embedding`,
          embeddingModel: sql`excluded.embedding_model`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`excluded.content_hash != workspace_search_chunks.content_hash`,
      });
  }

  async removeChunk(orgId: string, entityType: WorkspaceEntityTypeParam, entityId: number): Promise<void> {
    await this.db
      .delete(workspaceSearchChunks)
      .where(
        and(
          eq(workspaceSearchChunks.orgId, orgId),
          eq(workspaceSearchChunks.entityType, entityType),
          eq(workspaceSearchChunks.entityId, entityId),
        ),
      );
  }

  reindexEntity(_orgId: string, _entityType: WorkspaceEntityTypeParam, _entityId: number): Promise<void> {
    return Promise.reject(new NotImplementedException("reindexEntity wiring is deferred to Phase 1.2"));
  }

  reindexOrg(_orgId: string, _entityType: WorkspaceEntityTypeParam): Promise<{ indexed: number; skipped: number }> {
    return Promise.resolve({ indexed: 0, skipped: 0 });
  }
}
