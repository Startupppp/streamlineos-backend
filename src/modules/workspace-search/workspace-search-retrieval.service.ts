import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { workspaceSearchChunks } from "../../db/schema";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { WorkspaceEntityTypeParam } from "./dto/workspace-search.schemas";

const SNIPPET_LEN = 200;
const RRF_K = 60;
const MAX_POOL = 60;

export interface WorkspaceHit {
  entityType: string;
  entityId: number;
  title: string;
  snippet: string;
  urlPath: string;
  freshness: Date;
}

type EntityTypeKey = WorkspaceEntityTypeParam;

const PERMISSION_MAP: Record<EntityTypeKey, string[]> = {
  project: ["projects:view"],
  ticket: ["projects:view", "projects:tickets:view"],
  lead: ["crm:leads:view"],
  deal: ["crm:deals:read"],
  contact: ["crm:contacts:view"],
  client: ["crm:clients:read"],
};

@Injectable()
export class WorkspaceSearchRetrievalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
  ) {}

  private getAllowedTypes(user: CurrentUserContext): EntityTypeKey[] {
    if (user.isPlatformAdmin || user.isOrgOwner) {
      return ["project", "ticket", "lead", "deal", "contact", "client"];
    }
    const perms = new Set(user.permissions);
    return (Object.keys(PERMISSION_MAP) as EntityTypeKey[]).filter((type) =>
      PERMISSION_MAP[type].every((p) => perms.has(p)),
    );
  }

  async retrieve(
    user: CurrentUserContext,
    query: string,
    requestedTypes: EntityTypeKey[] | undefined,
    limit: number,
  ): Promise<WorkspaceHit[]> {
    const allowedTypes = this.getAllowedTypes(user);
    const scopedTypes = requestedTypes
      ? allowedTypes.filter((t) => requestedTypes.includes(t))
      : allowedTypes;

    if (scopedTypes.length === 0) return [];

    const q = query.trim();
    if (!q) return [];

    const pool = Math.max(limit * 3, MAX_POOL);
    const lists: string[][] = [];

    const kwHits = await this.keywordCandidates(user.orgId, q, scopedTypes, pool);
    if (kwHits.length > 0) lists.push(kwHits.map((r) => `${r.entityType}:${r.entityId}`));

    if (this.embeddings.isConfigured()) {
      const vecHits = await this.vectorCandidates(user.orgId, q, scopedTypes, pool);
      if (vecHits.length > 0) lists.push(vecHits.map((r) => `${r.entityType}:${r.entityId}`));
    }

    const fusedKeys = this.fuse(lists).slice(0, limit);
    if (fusedKeys.length === 0) return [];

    return this.hydrate(user.orgId, fusedKeys, q, scopedTypes);
  }

  private async keywordCandidates(
    orgId: string,
    q: string,
    types: string[],
    pool: number,
  ): Promise<{ entityType: string; entityId: number }[]> {
    const tsquery = sql`websearch_to_tsquery('english', ${q})`;
    const term = `%${q}%`;
    const rows = await this.db
      .select({
        entityType: workspaceSearchChunks.entityType,
        entityId: workspaceSearchChunks.entityId,
      })
      .from(workspaceSearchChunks)
      .where(
        and(
          eq(workspaceSearchChunks.orgId, orgId),
          inArray(workspaceSearchChunks.entityType, types),
          sql`(${workspaceSearchChunks.fts} @@ ${tsquery} OR (numnode(${tsquery}) = 0 AND (${workspaceSearchChunks.title} ILIKE ${term} OR ${workspaceSearchChunks.content} ILIKE ${term})))`,
        ),
      )
      .orderBy(
        sql`ts_rank(${workspaceSearchChunks.fts}, ${tsquery}) DESC`,
        sql`${workspaceSearchChunks.updatedAt} DESC`,
      )
      .limit(pool);
    return rows;
  }

  private async vectorCandidates(
    orgId: string,
    q: string,
    types: string[],
    pool: number,
  ): Promise<{ entityType: string; entityId: number }[]> {
    try {
      const vec = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(q));
      const distance = sql`${workspaceSearchChunks.embedding} <=> ${vec}::vector`;
      const rows = await this.db
        .select({
          entityType: workspaceSearchChunks.entityType,
          entityId: workspaceSearchChunks.entityId,
        })
        .from(workspaceSearchChunks)
        .where(
          and(
            eq(workspaceSearchChunks.orgId, orgId),
            inArray(workspaceSearchChunks.entityType, types),
            isNotNull(workspaceSearchChunks.embedding),
          ),
        )
        .orderBy(distance)
        .limit(pool);

      const seen = new Set<string>();
      const result: { entityType: string; entityId: number }[] = [];
      for (const row of rows) {
        const key = `${row.entityType}:${row.entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(row);
        if (result.length >= pool) break;
      }
      return result;
    } catch {
      return [];
    }
  }

  private async hydrate(
    orgId: string,
    keys: string[],
    query: string,
    types: string[],
  ): Promise<WorkspaceHit[]> {
    const parsed = keys.map((k) => {
      const sep = k.lastIndexOf(":");
      return { type: k.slice(0, sep), id: parseInt(k.slice(sep + 1), 10) };
    });
    const ids = parsed.map((e) => e.id);
    if (ids.length === 0) return [];

    const rows = await this.db
      .select({
        entityType: workspaceSearchChunks.entityType,
        entityId: workspaceSearchChunks.entityId,
        title: workspaceSearchChunks.title,
        content: workspaceSearchChunks.content,
        urlPath: workspaceSearchChunks.urlPath,
        updatedAt: workspaceSearchChunks.updatedAt,
      })
      .from(workspaceSearchChunks)
      .where(
        and(
          eq(workspaceSearchChunks.orgId, orgId),
          inArray(workspaceSearchChunks.entityType, types),
          inArray(workspaceSearchChunks.entityId, ids),
        ),
      );

    const rowMap = new Map(rows.map((r) => [`${r.entityType}:${r.entityId}`, r]));
    const order = new Map(keys.map((k, i) => [k, i]));

    return keys
      .map((key) => {
        const r = rowMap.get(key);
        if (!r) return null;
        return {
          entityType: r.entityType,
          entityId: r.entityId,
          title: r.title,
          snippet: this.buildSnippet(r.content, query),
          urlPath: r.urlPath,
          freshness: r.updatedAt,
        };
      })
      .filter((h): h is WorkspaceHit => h !== null)
      .sort(
        (a, b) =>
          (order.get(`${a.entityType}:${a.entityId}`) ?? 0) -
          (order.get(`${b.entityType}:${b.entityId}`) ?? 0),
      );
  }

  private fuse(lists: string[][]): string[] {
    const scores = new Map<string, number>();
    for (const list of lists) {
      list.forEach((key, rank) => {
        scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
      });
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }

  private buildSnippet(content: string, query: string): string {
    const text = content.trim();
    if (!text) return "";
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    const start = idx > 0 ? idx : 0;
    return text.slice(start, start + SNIPPET_LEN).trim();
  }
}
