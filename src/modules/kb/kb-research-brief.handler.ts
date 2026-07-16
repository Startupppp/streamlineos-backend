import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbResearchBriefs, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { getFeatureCost } from "../ai/billing/ai-cost-catalog";
import type { AiJobHandler, AiJobContext } from "../ai-jobs/ai-job-handler";
import { KbSearchService } from "./kb-search.service";
import { KbEventsService } from "./kb-events.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const RESEARCH_BRIEF_SYSTEM_PROMPT =
  "You are a research assistant. Synthesize a comprehensive, well-structured report in Markdown using ONLY the provided sources. " +
  "Open with a one-sentence executive summary, then organize findings under clear headings. Use bullet points for key facts. " +
  "Be thorough but concise. Do not invent facts not present in the sources.";

const MAX_CONTEXT_CHARS = 1500;

@Injectable()
export class KbResearchBriefHandler implements AiJobHandler {
  readonly type = "kb.research-brief";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly search: KbSearchService,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
  ) {}

  async handle(job: AiJobContext): Promise<Record<string, unknown>> {
    const briefId = Number(job.payload["briefId"]);
    const topic = String(job.payload["topic"] ?? "");
    const spaceId = job.payload["spaceId"] != null ? Number(job.payload["spaceId"]) : undefined;

    await this.db
      .update(kbResearchBriefs)
      .set({ status: "running" })
      .where(and(eq(kbResearchBriefs.id, briefId), eq(kbResearchBriefs.orgId, job.orgId)));

    try {
      const userCtx = await this.buildUserContext(job);
      const articles = await this.search.retrieveTopArticles(userCtx, topic, 12, spaceId);
      const sources = await this.search.retrieveTopSources(userCtx, topic, 6);

      const contextParts: string[] = [
        ...articles.map((a, i) => `Source ${i + 1} — ${a.title}\n${(a.contentText ?? "").slice(0, MAX_CONTEXT_CHARS)}`),
        ...sources.map((s, i) => `Document ${articles.length + i + 1} — ${s.title}\n${s.snippet}`),
      ];
      const context = contextParts.join("\n\n---\n\n");

      const gatewayResult = await this.aiGateway.invokeText({
        actor: { orgId: job.orgId, userId: job.userId ?? "system" },
        feature: "kb.research-brief",
        tier: "standard",
        maxTokens: 2048,
        charge: { credits: getFeatureCost("kb.research-brief") },
        prompt: {
          system: RESEARCH_BRIEF_SYSTEM_PROMPT,
          user: `Topic: ${topic}\n\nSources:\n${context}`,
        },
      });

      if (!gatewayResult.ok) {
        throw new Error(gatewayResult.message);
      }

      const citations = [
        ...articles.map((a) => ({
          kind: a.kind,
          id: a.id,
          title: a.title,
          href: a.kind === "article" ? `/support/kb/${a.id}` : `/support/kb/pages/${a.id}`,
          updatedAt: a.updatedAt.toISOString(),
        })),
        ...sources.map((s) => ({
          kind: "source",
          id: s.sourceId,
          title: s.title,
          href: null,
          updatedAt: s.updatedAt.toISOString(),
        })),
      ];

      await this.db
        .update(kbResearchBriefs)
        .set({
          status: "completed",
          report: gatewayResult.data,
          citations,
          sourceCount: citations.length,
        })
        .where(eq(kbResearchBriefs.id, briefId));

      await this.events.record(job.orgId, "research_brief_requested", {
        actorId: job.userId,
        query: topic,
        metadata: { briefId, sourceCount: citations.length },
      });

      return { briefId, status: "completed" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(kbResearchBriefs)
        .set({ status: "failed", errorMessage: message })
        .where(eq(kbResearchBriefs.id, briefId));
      return { briefId, status: "failed" };
    }
  }

  private async buildUserContext(job: AiJobContext): Promise<CurrentUserContext> {
    const member = job.userId
      ? await this.db.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, job.orgId),
            eq(organizationMembers.userId, job.userId),
          ),
        })
      : null;

    return {
      orgId: job.orgId,
      userId: job.userId ?? "",
      branchId: null,
      role: member?.role ?? "member",
      permissions: [],
      enabledModules: [],
      plan: null,
      isPlatformAdmin: false,
      isOrgOwner: member?.isOwner ?? false,
      sessionId: "",
    };
  }
}
