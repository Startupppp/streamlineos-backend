import { z } from "zod";
import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type {
  KbSearchRetrievalService,
  RetrievedSource,
  RetrievedSourceDocument,
} from "./kb-search-retrieval.service";
import {
  assemblePassages,
  buildKbContext,
  KB_BRIEF_CONTEXT_BUDGET,
  type KbContextPassage,
} from "./kb-ask-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const MAX_REFINE_COUNT = 2;
const PLAN_MAX_QUESTIONS = 5;

const SubQuestionsSchema = z.object({
  subQuestions: z
    .array(z.string())
    .min(1)
    .max(PLAN_MAX_QUESTIONS)
    .describe("Focused sub-questions to guide research"),
});

const CritiqueSchema = z.object({
  grounded: z.boolean().describe("True if all draft claims are supported by the retrieved context"),
  gaps: z.array(z.string()).describe("List of specific factual gaps or unsupported claims found"),
});

export interface BriefCitation {
  kind: string;
  id: number;
  title: string;
  href: string | null;
  updatedAt: string;
}

const BriefState = Annotation.Root({
  topic: Annotation<string>(),
  spaceId: Annotation<number | undefined>(),
  userCtx: Annotation<CurrentUserContext>(),
  actor: Annotation<{ orgId: string; userId: string }>(),
  subQuestions: Annotation<string[]>(),
  retrieved: Annotation<{
    articles: RetrievedSource[];
    sources: RetrievedSourceDocument[];
    documentPassages: KbContextPassage[];
  }>(),
  draft: Annotation<string>(),
  critique: Annotation<{ grounded: boolean; gaps: string[] }>(),
  refineCount: Annotation<number>(),
  report: Annotation<string>(),
  citations: Annotation<BriefCitation[]>(),
});

type BriefStateType = typeof BriefState.State;

export interface BriefGraphDeps {
  gateway: AiGatewayService;
  search: KbSearchRetrievalService;
}

function buildContext(retrieved: BriefStateType["retrieved"]): string {
  const passages = assemblePassages(
    retrieved.articles,
    retrieved.sources,
    retrieved.documentPassages,
  );
  return buildKbContext(passages, KB_BRIEF_CONTEXT_BUDGET);
}

function buildCitations(retrieved: BriefStateType["retrieved"]): BriefCitation[] {
  return [
    ...retrieved.articles.map((a) => ({
      kind: a.kind,
      id: a.id,
      title: a.title,
      href: a.kind === "article" ? `/support/kb/${a.id}` : `/support/kb/pages/${a.id}`,
      updatedAt: a.updatedAt.toISOString(),
    })),
    ...retrieved.sources.map((s) => ({
      kind: "source",
      id: s.sourceId,
      title: s.title,
      href: null,
      updatedAt: s.updatedAt.toISOString(),
    })),
  ];
}

export function buildResearchBriefGraph(deps: BriefGraphDeps) {
  const { gateway, search } = deps;

  async function planNode(state: BriefStateType): Promise<Partial<BriefStateType>> {
    const result = await gateway.invokeStructured({
      actor: state.actor,
      feature: "kb.research-brief",
      tier: "fast",
      maxTokens: 512,
      charge: true,
      schema: SubQuestionsSchema,
      prompt: {
        system:
          "You are a research planner. Generate 3-5 concise, focused sub-questions that will guide thorough research on the given topic. Each question should target a distinct aspect.",
        user: `Topic: ${state.topic}`,
      },
    });

    if (!result.ok) throw new Error(result.message);
    return { subQuestions: result.data.subQuestions };
  }

  async function retrieveNode(state: BriefStateType): Promise<Partial<BriefStateType>> {
    const queries = [state.topic, ...state.subQuestions].slice(0, PLAN_MAX_QUESTIONS + 1);
    const articleMap = new Map<string, RetrievedSource>();
    const sourceMap = new Map<number, RetrievedSourceDocument>();

    await Promise.all(
      queries.map(async (q) => {
        const [arts, srcs] = await Promise.all([
          search.retrieveTopArticles(state.userCtx, q, 5, state.spaceId),
          search.retrieveTopSources(state.userCtx, q, 3),
        ]);
        for (const a of arts) {
          const key = `${a.kind}:${a.id}`;
          if (!articleMap.has(key)) articleMap.set(key, a);
        }
        for (const s of srcs) {
          if (!sourceMap.has(s.sourceId)) sourceMap.set(s.sourceId, s);
        }
      }),
    );

    const articles = Array.from(articleMap.values());
    const articleIds = articles.filter((a) => a.kind === "article").map((a) => a.id);
    const pageIds = articles.filter((a) => a.kind === "page").map((a) => a.id);
    const documentPassages = await search.retrieveDocumentPassages(
      state.userCtx,
      state.topic,
      articleIds,
      pageIds,
    );

    return {
      retrieved: {
        articles,
        sources: Array.from(sourceMap.values()),
        documentPassages,
      },
    };
  }

  async function draftNode(state: BriefStateType): Promise<Partial<BriefStateType>> {
    const context = buildContext(state.retrieved);
    const gapGuidance =
      state.refineCount > 0 && state.critique.gaps.length > 0
        ? `\n\nPrior review found these gaps — address them only if the context supports it:\n${state.critique.gaps.map((g) => `- ${g}`).join("\n")}`
        : "";

    const result = await gateway.invokeText({
      actor: state.actor,
      feature: "kb.research-brief",
      tier: "standard",
      maxTokens: 2048,
      charge: true,
      prompt: {
        system:
          "You are a research assistant. Synthesize a comprehensive, well-structured report in Markdown using ONLY the provided sources. " +
          "Open with a one-sentence executive summary, then organize findings under clear headings. Use bullet points for key facts. " +
          "Be thorough but concise. Do not invent facts not present in the sources.",
        user: `Topic: ${state.topic}${gapGuidance}\n\nSources:\n${context}`,
      },
    });

    if (!result.ok) throw new Error(result.message);
    return { draft: result.data };
  }

  async function reviewNode(state: BriefStateType): Promise<Partial<BriefStateType>> {
    const context = buildContext(state.retrieved);

    const result = await gateway.invokeStructured({
      actor: state.actor,
      feature: "kb.research-brief",
      tier: "fast",
      maxTokens: 512,
      charge: true,
      schema: CritiqueSchema,
      prompt: {
        system:
          "You are a grounding critic. Check whether every factual claim in the draft report is directly supported by the provided source context. " +
          "Return grounded=true only if ALL claims are supported. List any unsupported claims or gaps as gaps[].",
        user: `Source Context:\n${context}\n\n---\n\nDraft Report:\n${state.draft}`,
      },
    });

    if (!result.ok) throw new Error(result.message);
    return { critique: result.data, refineCount: state.refineCount + 1 };
  }

  async function finalizeNode(state: BriefStateType): Promise<Partial<BriefStateType>> {
    return {
      report: state.draft,
      citations: buildCitations(state.retrieved),
    };
  }

  function critiqueRouter(state: BriefStateType): "draft" | "finalize" {
    if (!state.critique.grounded && state.refineCount < MAX_REFINE_COUNT) {
      return "draft";
    }
    return "finalize";
  }

  const graph = new StateGraph(BriefState)
    .addNode("plan", planNode)
    .addNode("retrieve", retrieveNode)
    .addNode("generate", draftNode)
    .addNode("review", reviewNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "plan")
    .addEdge("plan", "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", "review")
    .addConditionalEdges("review", critiqueRouter, {
      draft: "generate",
      finalize: "finalize",
    })
    .addEdge("finalize", END);

  return graph.compile();
}

export type CompiledBriefGraph = ReturnType<typeof buildResearchBriefGraph>;

export async function runResearchBrief(
  graph: CompiledBriefGraph,
  input: {
    topic: string;
    spaceId?: number;
    userCtx: CurrentUserContext;
    actor: { orgId: string; userId: string };
  },
): Promise<{ report: string; citations: BriefCitation[] }> {
  const initialState: Partial<BriefStateType> = {
    topic: input.topic,
    spaceId: input.spaceId,
    userCtx: input.userCtx,
    actor: input.actor,
    subQuestions: [],
    retrieved: { articles: [], sources: [], documentPassages: [] },
    draft: "",
    critique: { grounded: false, gaps: [] },
    refineCount: 0,
    report: "",
    citations: [],
  };

  const finalState = await graph.invoke(initialState);

  return {
    report: finalState.report ?? "",
    citations: finalState.citations ?? [],
  };
}
