import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbResearchBriefs, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AiJobHandlerRegistry, type AiJobHandler, type AiJobContext } from "../../ai/jobs/ai-job-handler";
import { KbSearchService } from "./kb-search.service";
import { KbEventsService } from "../core/kb-events.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { buildResearchBriefGraph, runResearchBrief } from "./kb-research-brief.graph";

@Injectable()
export class KbResearchBriefHandler implements AiJobHandler, OnModuleInit {
  readonly type = "kb.research-brief";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly search: KbSearchService,
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
      const userCtx = await this.buildUserContext(job);
      const actor = { orgId: job.orgId, userId: job.userId ?? "system" };

      const graph = buildResearchBriefGraph({ gateway: this.aiGateway, search: this.search });
      const { report, citations } = await runResearchBrief(graph, { topic, spaceId, userCtx, actor });

      await this.db
        .update(kbResearchBriefs)
        .set({
          status: "completed",
          report,
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
      role: member?.role ?? "member",
      permissions: [],
      isOrgOwner: member?.isOwner ?? false,
      tokenScopes: null,
      sessionId: "",
    };
  }
}
