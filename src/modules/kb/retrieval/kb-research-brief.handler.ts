import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, sql, sum } from "drizzle-orm";
import { kbResearchBriefs, organizationMembers } from "../../../db/schema";
import { kbAiInteractions } from "../../../db/schema/kb/ai-interactions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AiJobHandlerRegistry, type AiJobHandler, type AiJobContext } from "../../ai/jobs/ai-job-handler";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbEventsService } from "../core/kb-events.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  ACCOUNT_ONLY_PRINCIPAL,
  actingMembershipId,
  humanSessionPrincipal,
} from "../../../common/auth/principal";
import { buildResearchBriefGraph, runResearchBrief } from "./kb-research-brief.graph";

@Injectable()
export class KbResearchBriefHandler implements AiJobHandler, OnModuleInit {
  readonly type = "kb.research-brief";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly search: KbSearchRetrievalService,
    private readonly aiGateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly registry: AiJobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(job: AiJobContext): Promise<Record<string, unknown>> {
    const briefId = Number(job.payload["briefId"]);
    const topic = String(job.payload["topic"] ?? "");
    const spaceId = job.payload["spaceId"] != null ? Number(job.payload["spaceId"]) : undefined;

    await this.db
      .update(kbResearchBriefs)
      .set({ status: "running" })
      .where(and(eq(kbResearchBriefs.id, briefId), eq(kbResearchBriefs.orgId, job.orgId)));

    try {
      const hasContent = await this.orgHasIndexedContent(job.orgId);
      if (!hasContent) {
        await this.db
          .update(kbResearchBriefs)
          .set({
            status: "failed",
            errorMessage: "The knowledge base has no indexed content yet — nothing to research.",
          })
          .where(and(eq(kbResearchBriefs.id, briefId), eq(kbResearchBriefs.orgId, job.orgId)));
        return { briefId, status: "failed" };
      }

      const userCtx = await this.buildUserContext(job);
      const actor = { orgId: job.orgId, userId: job.userId ?? "system" };
      const membershipId = actingMembershipId(userCtx.principal);

      const briefStartedAt = new Date();
      const graph = buildResearchBriefGraph({ gateway: this.aiGateway, search: this.search });
      const { report, citations } = await runResearchBrief(graph, { topic, spaceId, userCtx, actor });

      const usageMeta = await this.aggregateBriefUsage(job.orgId, membershipId, briefStartedAt);

      await this.db
        .update(kbResearchBriefs)
        .set({
          status: "completed",
          report,
          citations,
          sourceCount: citations.length,
          costCredits: usageMeta.costCredits,
          provider: usageMeta.provider,
          model: usageMeta.model,
        })
        .where(eq(kbResearchBriefs.id, briefId));

      await this.events.record(job.orgId, "research_brief_requested", {
        actorMembershipId: actingMembershipId(userCtx.principal) ?? null,
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

  private async aggregateBriefUsage(
    orgId: string,
    membershipId: number | null,
    startedAt: Date,
  ): Promise<{ costCredits: number | null; provider: string | null; model: string | null }> {
    const conditions = [
      eq(kbAiInteractions.orgId, orgId),
      gte(kbAiInteractions.createdAt, startedAt),
    ];
    if (membershipId !== null) {
      conditions.push(eq(kbAiInteractions.actorMembershipId, membershipId));
    }

    const [totals] = await this.db
      .select({ totalCredits: sum(kbAiInteractions.costCredits) })
      .from(kbAiInteractions)
      .where(and(...conditions));

    const firstRow = await this.db
      .select({ provider: kbAiInteractions.provider, model: kbAiInteractions.model })
      .from(kbAiInteractions)
      .where(and(...conditions))
      .limit(1);

    const rawCredits = totals?.totalCredits;
    const costCredits = rawCredits != null ? Number(rawCredits) : null;
    return {
      costCredits: Number.isFinite(costCredits) ? costCredits : null,
      provider: firstRow[0]?.provider ?? null,
      model: firstRow[0]?.model ?? null,
    };
  }

  private async orgHasIndexedContent(orgId: string): Promise<boolean> {
    const rows = await this.db.execute(
      sql`SELECT 1 AS one FROM kb_article_chunks WHERE org_id = ${orgId} LIMIT 1`,
    );
    return rows.length > 0;
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
      role: member?.role ?? "member",
      isOrgOwner: member?.isOwner ?? false,
      tokenScopes: null,
      sessionId: "",
      principal: member
        ? humanSessionPrincipal(member.id, member.isOwner)
        : ACCOUNT_ONLY_PRINCIPAL,
    };
  }
}
