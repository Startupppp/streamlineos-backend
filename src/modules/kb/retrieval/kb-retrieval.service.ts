import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import type {
  RetrievedSource,
  RetrievedSourceDocument,
  DegradableContextPassage,
  RetrievalChannelKind,
} from "./kb-search-retrieval.service";
import {
  resolveKbRetrievalStrategy,
  KB_DEGRADED_ARTICLE_LIMIT,
  type KbRetrievalStrategy,
} from "./kb-retrieval-strategy";
import { KB_ASK_MAX_CONTEXT_DOCUMENTS } from "./kb-ask-context";
import type { KbPageStatus } from "../core/collection/knowledge-collection.types";

export interface KbRetrieveOptions {
  documentsLimit?: number;
  sourcesLimit?: number;
  spaceId?: number;
  verifiedOnly?: boolean;
  sourceIds?: number[];
  pageIds?: number[];
  ownerMembershipId?: number;
  status?: KbPageStatus;
}

export interface KbRetrievalDegradation {
  documents: boolean;
  sources: boolean;
  passages: boolean;
}

export function isAnyChannelDegraded(d: KbRetrievalDegradation): boolean {
  return d.documents || d.sources || d.passages;
}

function channelSignalsDegradation(kind: RetrievalChannelKind): boolean {
  return kind === "failed" || kind === "degraded";
}

export interface KbRetrievalResult {
  documents: RetrievedSource[];
  sources: RetrievedSourceDocument[];
  passages: DegradableContextPassage[];
  degraded: KbRetrievalDegradation;
  strategy: KbRetrievalStrategy;
}

@Injectable()
export class KbRetrievalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly search: KbSearchRetrievalService,
    @Optional()
    @Inject(CacheService)
    private readonly cache: CacheService | null = null,
  ) {}

  async retrieve(
    user: CurrentUserContext,
    query: string,
    opts: KbRetrieveOptions = {},
  ): Promise<KbRetrievalResult> {
    const documentsLimit = opts.documentsLimit ?? KB_ASK_MAX_CONTEXT_DOCUMENTS;

    const { hasContent, strategy } = await runInTenantTransaction(
      this.db,
      async () => {
        const content = await this.hasIndexedContent(user.orgId);
        if (!content) return { hasContent: false, strategy: { kind: "exact" } as const };
        const strat = await resolveKbRetrievalStrategy(
          this.db,
          this.cache,
          user.orgId,
          documentsLimit,
        );
        return { hasContent: true, strategy: strat };
      },
      { orgId: user.orgId },
    );

    if (!hasContent) {
      return {
        documents: [],
        sources: [],
        passages: [],
        degraded: { documents: false, sources: false, passages: false },
        strategy,
      };
    }

    const embedding = await this.search.resolveQueryEmbedding(query, user.orgId);
    const effectiveDocumentsLimit =
      embedding.vectorLiteral === null ? KB_DEGRADED_ARTICLE_LIMIT : documentsLimit;

    const { documents, sources, passages, documentsKind, sourcesKind, passagesKind } =
      await runInTenantTransaction(
      this.db,
      async () => {
        const [docsOutcome, srcOutcome] = await Promise.all([
          this.search.retrieveTopArticlesWithOutcome(
            user,
            query,
            effectiveDocumentsLimit,
            opts.spaceId,
            opts.verifiedOnly,
            embedding,
            opts.pageIds,
            opts.ownerMembershipId,
            opts.status,
          ),
          this.search.retrieveTopSourcesWithOutcome(
            user,
            query,
            opts.sourcesLimit ?? 4,
            opts.sourceIds,
            embedding,
            opts.spaceId,
          ),
        ]);

        const docs = docsOutcome.results;
        const articleIds = docs.filter((d) => d.kind === "article").map((d) => d.id);
        const pageIds = docs.filter((d) => d.kind === "page").map((d) => d.id);

        const psgOutcome =
          articleIds.length > 0 || pageIds.length > 0
            ? await this.search.retrieveDocumentPassagesWithOutcome(
                user,
                query,
                articleIds,
                pageIds,
                embedding,
              )
            : { kind: "disabled" as const, results: [] };

        return {
          documents: docs,
          sources: srcOutcome.results,
          passages: psgOutcome.results,
          documentsKind: docsOutcome.kind,
          sourcesKind: srcOutcome.kind,
          passagesKind: psgOutcome.kind,
        };
      },
      { orgId: user.orgId },
    );

    const embeddingFailed = embedding.vectorLiteral === null;
    const degraded: KbRetrievalDegradation = {
      documents: embeddingFailed || channelSignalsDegradation(documentsKind),
      sources:
        embeddingFailed ||
        channelSignalsDegradation(sourcesKind) ||
        sources.some((s) => s.degraded === true),
      passages:
        embeddingFailed ||
        channelSignalsDegradation(passagesKind) ||
        passages.some((p) => p.degraded === true),
    };

    return { documents, sources, passages, degraded, strategy };
  }

  private async hasIndexedContent(orgId: string): Promise<boolean> {
    const rows = await this.db.execute(
      sql`SELECT 1 AS one FROM kb_article_chunks WHERE org_id = ${orgId} LIMIT 1`,
    );
    return rows.length > 0;
  }
}
