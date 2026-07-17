import { Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { randomUUID } from "crypto";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiSummariesService } from "../../ai-summaries/ai-summaries.service";
import { ProjectsAnalyticsService } from "../../projects/projects-analytics.service";
import { CrmSalesDashboardService } from "../../crm/crm-sales-dashboard.service";
import { SupportReportsService } from "../../support/support-reports.service";
import { getFeatureCost } from "../billing/ai-cost-catalog";
import type { SnapshotCitation } from "../../ai-summaries/ai-summaries.types";

export interface BriefCitation {
  id: string;
  title: string;
  href: string;
}

export interface ExecutiveBriefResult {
  narrative: string;
  citations: BriefCitation[];
  sources: Record<string, unknown>;
  uncertaintyNotes: string[];
  generatedAt: string;
}

@Injectable()
export class ExecutiveBriefService {
  private readonly logger = new Logger(ExecutiveBriefService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly summaries: AiSummariesService,
  ) {}

  private getSvc<T>(token: abstract new (...args: never[]) => T): T {
    return this.moduleRef.get(token, { strict: false });
  }

  async getLatest(orgId: string) {
    return this.summaries.getLatestWithDiff(orgId, "executive_brief", orgId);
  }

  async generate(orgId: string, userId: string): Promise<ExecutiveBriefResult> {
    const [projectsResult, crmResult, supportResult] = await Promise.allSettled([
      this.getSvc(ProjectsAnalyticsService).getOrgProjectHealthSummary(orgId),
      this.getSvc(CrmSalesDashboardService).getSalesDashboard(orgId),
      this.getSvc(SupportReportsService).getOverview(orgId, {}),
    ]);

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

    const invokeResult = await this.getSvc(AiGatewayService).invokeText({
      actor: { orgId, userId },
      feature: "exec.brief.generate",
      prompt: {
        system:
          "You are an executive AI assistant. Produce a concise, factual business brief for senior leadership. Cite each data source by module name. Never fabricate metrics not present in the data.",
        user: buildBriefPrompt(sources, uncertaintyNotes),
      },
      tier: "standard",
      maxTokens: 1024,
      charge: {
        credits: getFeatureCost("exec.brief.generate"),
        idempotencyKey: `exec-brief-${orgId}-${randomUUID()}`,
      },
    });

    let narrative = "";
    const citations: BriefCitation[] = [];

    if (invokeResult.ok) {
      narrative = invokeResult.data;
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
