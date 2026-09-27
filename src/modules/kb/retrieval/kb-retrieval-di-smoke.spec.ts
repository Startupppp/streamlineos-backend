import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { REDIS } from "../../../common/cache/cache.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { KbEventsService } from "../core/kb-events.service";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { KbLinkedDocumentAskSource } from "../linked-documents/kb-linked-document-ask-source";
import { KbAskService } from "./kb-ask.service";
import { KbRetrievalService } from "./kb-retrieval.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { KbSearchService } from "./kb-search.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbCandidateService } from "./kb-candidate.service";

describe("KB retrieval module DI wiring (AV-01)", () => {
  let askService: KbAskService;
  let retrievalService: KbRetrievalService;
  let searchRetrievalService: KbSearchRetrievalService;
  let chatHistoryService: KbChatHistoryService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        KbAskService,
        KbRetrievalService,
        KbSearchRetrievalService,
        KbChatHistoryService,
        KbSearchService,
        KbAskCitationService,
        KbCitationVisibilityService,
        KbCandidateService,
        { provide: DRIZZLE, useValue: {} },
        { provide: REDIS, useValue: null },
        { provide: AiGatewayService, useValue: {} },
        { provide: KbEventsService, useValue: {} },
        { provide: AccessService, useValue: {} },
        { provide: KnowledgeAuthorizationService, useValue: {} },
        { provide: KbLinkedDocumentAskSource, useValue: {} },
        { provide: CacheService, useValue: {} },
      ],
    }).compile();

    askService = module.get(KbAskService);
    retrievalService = module.get(KbRetrievalService);
    searchRetrievalService = module.get(KbSearchRetrievalService);
    chatHistoryService = module.get(KbChatHistoryService);
  });

  it("AV-01: KbAskService resolves from the container", () => {
    expect(askService).toBeDefined();
  });

  it("AV-01: KbAskService exposes ask and streamAsk methods", () => {
    expect(typeof askService.ask).toBe("function");
    expect(typeof askService.streamAsk).toBe("function");
  });

  it("AV-01: KbRetrievalService resolves from the container", () => {
    expect(retrievalService).toBeDefined();
  });

  it("AV-01: KbRetrievalService exposes retrieve method", () => {
    expect(typeof retrievalService.retrieve).toBe("function");
  });

  it("AV-01: KbSearchRetrievalService resolves from the container", () => {
    expect(searchRetrievalService).toBeDefined();
  });

  it("AV-01: KbSearchRetrievalService exposes retrieveTopArticles method", () => {
    expect(typeof searchRetrievalService.retrieveTopArticles).toBe("function");
  });

  it("AV-01: KbChatHistoryService resolves from the container", () => {
    expect(chatHistoryService).toBeDefined();
  });

  it("AV-01: KbChatHistoryService exposes listConversations method", () => {
    expect(typeof chatHistoryService.listConversations).toBe("function");
  });

  it("AV-01: no service resolves to null — BE-11 import type erasure would cause this", () => {
    expect(askService).not.toBeNull();
    expect(retrievalService).not.toBeNull();
    expect(searchRetrievalService).not.toBeNull();
    expect(chatHistoryService).not.toBeNull();
  });
});
