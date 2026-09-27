import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbLinkedDocumentAskSource } from "../linked-documents/kb-linked-document-ask-source";
import type { LinkedDocumentItem } from "../linked-documents/dto/kb-linked-documents-response.schemas";
import type { AskCitation } from "./kb-ask-context";

export interface CitableTop {
  kind: "article" | "page";
  id: number;
  title: string;
  slug?: string | null;
  spaceId: number | null;
  updatedAt: Date;
}

export interface CitableSource {
  sourceId: number;
  title: string;
  spaceId: number | null;
  updatedAt: Date;
}

@Injectable()
export class KbAskCitationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly citationVisibility: KbCitationVisibilityService,
    private readonly linkedDocuments: KbLinkedDocumentAskSource,
  ) {}

  async resolveCitations(
    user: CurrentUserContext,
    top: ReadonlyArray<CitableTop>,
    sources: ReadonlyArray<CitableSource>,
  ): Promise<AskCitation[]> {
    const articleIds = top.filter((s) => s.kind === "article").map((s) => s.id);
    const pageIds = top.filter((s) => s.kind === "page").map((s) => s.id);
    const sourceIds = sources.map((s) => s.sourceId);

    const [visibleArticles, visiblePages, visibleSources] = await Promise.all([
      articleIds.length > 0
        ? this.citationVisibility.visibleArticles(user, articleIds)
        : Promise.resolve(new Set<number>()),
      pageIds.length > 0
        ? this.citationVisibility.visiblePages(user, pageIds)
        : Promise.resolve(new Set<number>()),
      sourceIds.length > 0
        ? this.citationVisibility.visibleSources(user, sourceIds)
        : Promise.resolve(new Set<number>()),
    ]);

    const citations: AskCitation[] = [];
    for (const source of top) {
      if (source.kind === "article" && visibleArticles.has(source.id)) {
        citations.push({
          kind: "article",
          articleId: source.id,
          title: source.title,
          slug: source.slug ?? "",
          spaceId: source.spaceId,
          updatedAt: source.updatedAt,
        });
      } else if (source.kind === "page" && visiblePages.has(source.id)) {
        citations.push({
          kind: "page",
          pageId: source.id,
          title: source.title,
          spaceId: source.spaceId,
          updatedAt: source.updatedAt,
        });
      }
    }
    for (const s of sources) {
      if (visibleSources.has(s.sourceId)) {
        citations.push({
          kind: "source",
          sourceId: s.sourceId,
          title: s.title,
          spaceId: s.spaceId,
          updatedAt: s.updatedAt,
        });
      }
    }
    return citations;
  }

  async stillCitableDocuments(
    user: CurrentUserContext,
    linked: LinkedDocumentItem[],
  ): Promise<AskCitation[]> {
    const citable = await this.linkedDocuments.stillCitable(
      user,
      linked.map((document) => document.id),
    );
    return linked
      .filter((document) => citable.has(document.id))
      .map((document) => this.linkedDocuments.citationOf(document));
  }

  async assertReplayCitations(
    user: CurrentUserContext,
    citations: AskCitation[],
  ): Promise<void> {
    await runInTenantTransaction(
      this.db,
      async () => {
        const articleIds = citations.flatMap((citation) =>
          citation.kind === "article" ? [citation.articleId] : [],
        );
        const pageIds = citations.flatMap((citation) =>
          citation.kind === "page" ? [citation.pageId] : [],
        );
        const sourceIds = citations.flatMap((citation) =>
          citation.kind === "source" ? [citation.sourceId] : [],
        );
        const linkedDocumentIds = citations.flatMap((citation) =>
          citation.kind === "document" ? [citation.linkedDocumentId] : [],
        );
        const [articles, pages, sources, documents] = await Promise.all([
          articleIds.length
            ? this.citationVisibility.visibleArticles(user, articleIds)
            : Promise.resolve(new Set<number>()),
          pageIds.length
            ? this.citationVisibility.visiblePages(user, pageIds)
            : Promise.resolve(new Set<number>()),
          sourceIds.length
            ? this.citationVisibility.visibleSources(user, sourceIds)
            : Promise.resolve(new Set<number>()),
          this.linkedDocuments.stillCitable(user, linkedDocumentIds),
        ]);
        if (
          articleIds.some((id) => !articles.has(id)) ||
          pageIds.some((id) => !pages.has(id)) ||
          sourceIds.some((id) => !sources.has(id)) ||
          linkedDocumentIds.some((id) => !documents.has(id))
        )
          throw new NotFoundException(
            "The saved answer is no longer accessible",
          );
      },
      { orgId: user.orgId },
    );
  }
}
