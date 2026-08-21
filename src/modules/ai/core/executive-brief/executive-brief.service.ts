import { Inject, Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiSummariesService } from "../../summaries/ai-summaries.service";
import { ProjectsAnalyticsService } from "../../../build/core/projects-analytics.service";
import { CrmSalesDashboardService } from "../../../crm/core/crm-sales-dashboard.service";
import { SupportReportsService } from "../../../support/core/support-reports.service";
import type { SnapshotCitation } from "../../summaries/ai-summaries.types";
import type { AiUsageMeta } from "../gateway/ai-gateway.types";

export interface BriefCitation {
  id: string;
  title: string;
  href: string;
}

export interface ExecutiveBriefSnapshot {
  narrative: string;
  citations: BriefCitation[];
  uncertaintyNotes: string[];
  generatedAt: string;
  aiUsage?: AiUsageMeta | null;
}

export interface LatestBriefResponse {
  snapshot: ExecutiveBriefSnapshot | null;
  isStale: boolean;
  staleSinceMinutes?: number;
}

export interface ExecutiveBriefResult extends ExecutiveBriefSnapshot {
  sources: Record<string, unknown>;
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface StoredBriefPayload {
  narrative: string;
  citations: BriefCitation[];
  sources: Record<string, unknown>;
  uncertaintyNotes: string[];
}

@Injectable()
export class ExecutiveBriefService {
  private readonly logger = new Logger(ExecutiveBriefService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly moduleRef: ModuleRef,
    private readonly summaries: AiSummariesService,
  ) {}

  private getSvc<T>(token: abstract new (...args: never[]) => T): T {
    return this.moduleRef.get(token, { strict: false });
  }

  async getLatest(orgId: string): Promise<LatestBriefResponse> {
    const result = await this.summaries.getLatestWithDiff(orgId, "executive_brief", orgId);

    if (!result) {
      return { snapshot: null, isStale: false };
    }

    const { snapshot } = result;
    const ageMs = Date.now() - new Date(snapshot.createdAt).getTime();
    const isStale = ageMs > STALE_THRESHOLD_MS;
    const staleSinceMinutes = isStale ? Math.floor(ageMs / 60_000) : undefined;

    let payload: StoredBriefPayload;
    try {
      payload = JSON.parse(snapshot.summary) as StoredBriefPayload;
    } catch {
      this.logger.warn("Failed to parse executive brief snapshot summary JSON", { id: snapshot.id });
      return { snapshot: null, isStale };
    }

    return {
      snapshot: {
        narrative: payload.narrative ?? "",
        citations: Array.isArray(payload.citations) ? payload.citations : [],
        uncertaintyNotes: Array.isArray(payload.uncertaintyNotes) ? payload.uncertaintyNotes : [],
        generatedAt: snapshot.createdAt.toISOString(),
      },
      isStale,
      staleSinceMinutes,
    };
  }

  async generate(orgId: string, userId: string): Promise<ExecutiveBriefResult> {
    const [projectsResult, crmResult, supportResult] = await runInTenantTransaction(
      this.db,
      () =>
        Promise.allSettled([
          this.getSvc(ProjectsAnalyticsService).getOrgProjectHealthSummary(orgId),
          this.getSvc(CrmSalesDashboardService).getSalesDashboard(orgId),
          this.getSvc(SupportReportsService).getOverview(orgId, {}),
        ]),
      { orgId },
    );

    const sources: Record<string, unknown> = {};
    const uncertaintyNotes: string[] = [];

    if (projectsResult.status === "fulfilled") {
      sources.projects = projectsResult.value;
    } else {
      this.logger.warn("Projects health unavailable", (projectsResult.reason as Error)?.message);
      uncertaintyNotes.push("Projects health data unavailable.");
    }

    if (crmResult.status === "fulfilled") {
      sources.crm = crmResult.value;
    } else {
      this.logger.warn("CRM dashboard unavailable", (crmResult.reason as Error)?.message);
      uncertaintyNotes.push("CRM sales dashboard unavailable.");
    }

    if (supportResult.status === "fulfilled") {
      sources.support = supportResult.value;
    } else {
      this.logger.warn("Support overview unavailable", (supportResult.reason as Error)?.message);
      uncertaintyNotes.push("Support overview unavailable.");
    }

    const MODULE_MAP: Record<string, { title: string; href: string }> = {
      projects: { title: "Project Health", href: "/projects" },
      crm: { title: "CRM Sales Dashboard", href: "/crm" },
      support: { title: "Support Overview", href: "/support" },
    };

    const invokeResult = await this.getSvc(AiGatewayService).invokeTextWithUsage({
      actor: { orgId, userId },
      feature: "exec.brief.generate",
      prompt: {
        system:
          "You are an executive AI assistant. Produce a concise, factual business brief for senior leadership. Cite each data source by module name. Never fabricate metrics not present in the data.",
        user: buildBriefPrompt(sources, uncertaintyNotes),
      },
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    let narrative: string;
    const citations: BriefCitation[] = [];
    let aiUsage: AiUsageMeta | undefined;

    if (invokeResult.ok) {
      narrative = invokeResult.data;
      aiUsage = invokeResult.aiUsage;
      for (const key of Object.keys(sources)) {
        const m = MODULE_MAP[key];
        if (m) citations.push({ id: key, ...m });
      }
    } else {
      uncertaintyNotes.push(`Narrative generation failed: ${invokeResult.message}`);
      narrative = "Executive brief generation failed. Please retry.";
    }

    const snapshotCitations: SnapshotCitation[] = citations.map((c) => ({
      id: c.id,
      title: c.title,
      href: c.href,
    }));

    await this.summaries.saveSnapshot(
      orgId,
      "executive_brief",
      orgId,
      {
        summary: JSON.stringify({ narrative, citations, sources, uncertaintyNotes }),
        structured: {
          highlights: citations.map((c) => c.title),
          blockers: uncertaintyNotes,
          nextActions: [],
        },
        citations: snapshotCitations,
      },
      userId,
    );

    return {
      narrative,
      citations,
      sources,
      uncertaintyNotes,
      generatedAt: new Date().toISOString(),
      aiUsage,
    };
  }
}

function buildBriefPrompt(sources: Record<string, unknown>, uncertaintyNotes: string[]): string {
  const parts: string[] = ["Generate an executive business brief based on the following operational data:\n"];

  if (sources.projects) {
    const p = sources.projects as { total: number; healthy: number; atRisk: number; critical: number; avgScore: number };
    parts.push(
      `**Projects (source: /projects):** ${p.total} total projects. Healthy: ${p.healthy}, At Risk: ${p.atRisk}, Critical: ${p.critical}. Average health score: ${p.avgScore}/100.`,
    );
  }

  if (sources.crm) {
    parts.push(`**CRM/Sales (source: /crm):** ${JSON.stringify(sources.crm)}`);
  }

  if (sources.support) {
    const s = sources.support as { openTickets: number; slaBreachCount: number; avgFirstResponseMinutes: number | null };
    parts.push(
      `**Support (source: /support):** Open tickets: ${s.openTickets}, SLA breaches: ${s.slaBreachCount}, Avg first response: ${s.avgFirstResponseMinutes ?? "N/A"} min.`,
    );
  }

  if (uncertaintyNotes.length > 0) {
    parts.push(`\n**Data gaps (do not fabricate for these):** ${uncertaintyNotes.join("; ")}`);
  }

  parts.push(
    "\nStructure: 1-2 sentence overall health summary, then one paragraph per module with key metrics, then 3 strategic recommendations. Be concise and factual.",
  );

  return parts.join("\n");
}
