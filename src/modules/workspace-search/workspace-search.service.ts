import { Injectable } from "@nestjs/common";
import { WorkspaceSearchRetrievalService, type WorkspaceHit } from "./workspace-search-retrieval.service";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { getFeatureCost } from "../ai/billing/ai-cost-catalog";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AskBody, SearchQuery } from "./dto/workspace-search.schemas";

const NO_SOURCE_MESSAGE =
  "No permitted sources were found matching your query. You may not have access to the relevant modules, or no content has been indexed yet.";

export interface SearchResponse {
  hits: WorkspaceHit[];
  total: number;
  nextCursor: null;
}

export interface AskResponse {
  answer: string;
  citations: WorkspaceHit[];
  noPermittedSource: boolean;
}

@Injectable()
export class WorkspaceSearchService {
  constructor(
    private readonly retrieval: WorkspaceSearchRetrievalService,
    private readonly gateway: AiGatewayService,
  ) {}

  async search(user: CurrentUserContext, query: SearchQuery): Promise<SearchResponse> {
    const hits = await this.retrieval.retrieve(
      user,
      query.q,
      query.entityTypes,
      query.limit,
    );
    return { hits, total: hits.length, nextCursor: null };
  }

  async ask(user: CurrentUserContext, body: AskBody): Promise<AskResponse> {
    const hits = await this.retrieval.retrieve(user, body.q, body.entityTypes, 8);

    if (hits.length === 0) {
      return { answer: NO_SOURCE_MESSAGE, citations: [], noPermittedSource: true };
    }

    const context = hits
      .map((h, i) => `[${i + 1}] ${h.entityType.toUpperCase()}: ${h.title}\n${h.snippet}`)
      .join("\n\n");

    const featureCost = getFeatureCost("workspace.ask");
    const charge = featureCost > 0 ? { credits: featureCost } : undefined;

    const result = await this.gateway.invokeText({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "workspace.ask",
      tier: "fast",
      maxTokens: 512,
      ...(charge ? { charge } : {}),
      prompt: {
        system:
          "You are a helpful workspace assistant for StreamlineOS. Answer the user's question using only the provided context. Cite sources with [n] notation inline. Be concise and factual.",
        user: `Context:\n${context}\n\nQuestion: ${body.q}`,
      },
    });

    if (!result.ok) {
      return { answer: result.message, citations: [], noPermittedSource: false };
    }

    return {
      answer: result.data,
      citations: hits,
      noPermittedSource: false,
    };
  }
}
