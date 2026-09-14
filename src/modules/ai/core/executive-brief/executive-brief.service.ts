import { Inject, Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { z } from "zod";
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
import { createPipeableAiTextStream } from "../streaming/raw-ai-text-stream";
import type { AiTextStreamProduct } from "../streaming/ai-text-stream-route";
import {
  computeTokenCharge,
  milliToCredits,
} from "../billing/ai-model-pricing.constants";

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
  aiUsage?: AiUsageMeta;
}

const briefCitationSchema = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string(),
});

const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  credits: z.number(),
  costUsd: z.number(),
});

const storedBriefSnapshotSchema = z.object({
  narrative: z.string().optional(),
  citations: z.array(briefCitationSchema).optional(),
  uncertaintyNotes: z.array(z.string()).optional(),
  aiUsage: aiUsageMetaSchema.optional(),
});

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isProjectHealthSummary(value: unknown): value is {
  total: number;
  healthy: number;
  atRisk: number;
  critical: number;
  avgScore: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "total" in value &&
    "avgScore" in value
  );
}

function isSupportOverview(value: unknown): value is {
  openTickets: number;
  slaBreachCount: number;
  avgFirstResponseMinutes: number | null;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "openTickets" in value &&
    "slaBreachCount" in value
  );
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
    const result = await this.summaries.getLatestWithDiff(
      orgId,
      "executive_brief",
      orgId,
    );

    if (!result) {
      return { snapshot: null, isStale: false };
    }

    const { snapshot } = result;
    const ageMs = Date.now() - new Date(snapshot.createdAt).getTime();
    const isStale = ageMs > STALE_THRESHOLD_MS;
    const staleSinceMinutes = isStale ? Math.floor(ageMs / 60_000) : undefined;

    const parsed = storedBriefSnapshotSchema.safeParse(
      (() => {
        try {
          return JSON.parse(snapshot.summary);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) {
      this.logger.warn(
        "Failed to parse executive brief snapshot summary JSON",
        { id: snapshot.id },
      );
      return { snapshot: null, isStale };
    }

    return {
      snapshot: {
        narrative: parsed.data.narrative ?? "",
        citations: parsed.data.citations ?? [],
        uncertaintyNotes: parsed.data.uncertaintyNotes ?? [],
        generatedAt: snapshot.createdAt.toISOString(),
        aiUsage: parsed.data.aiUsage,
      },
      isStale,
      staleSinceMinutes,
    };
  }

  private async resolveContext(orgId: string) {
    const [projectsResult, crmResult, supportResult] =
      await runInTenantTransaction(
        this.db,
        () =>
          Promise.allSettled([
            this.getSvc(ProjectsAnalyticsService).getOrgProjectHealthSummary(
              orgId,
            ),
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
      this.logger.warn(
        "Projects health unavailable",
        errorMessage(projectsResult.reason),
      );
      uncertaintyNotes.push("Projects health data unavailable.");
    }

    if (crmResult.status === "fulfilled") {
      sources.crm = crmResult.value;
    } else {
      this.logger.warn(
        "CRM dashboard unavailable",
        errorMessage(crmResult.reason),
      );
      uncertaintyNotes.push("CRM sales dashboard unavailable.");
    }

    if (supportResult.status === "fulfilled") {
      sources.support = supportResult.value;
    } else {
      this.logger.warn(
        "Support overview unavailable",
        errorMessage(supportResult.reason),
      );
      uncertaintyNotes.push("Support overview unavailable.");
    }

    return { sources, uncertaintyNotes };
  }

  private resolveCitations(sources: Record<string, unknown>): BriefCitation[] {
    const moduleMap: Record<string, { title: string; href: string }> = {
      projects: { title: "Project Health", href: "/projects" },
      crm: { title: "CRM Sales Dashboard", href: "/crm" },
      support: { title: "Support Overview", href: "/support" },
    };

    return Object.keys(sources).flatMap((key) => {
      const module = moduleMap[key];
      return module ? [{ id: key, ...module }] : [];
    });
  }

  async streamGenerate(
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<AiTextStreamProduct> {
    const { sources, uncertaintyNotes } = await this.resolveContext(orgId);
    signal.throwIfAborted();
    const citations = this.resolveCitations(sources);
    const { stream, model } = await this.getSvc(
      AiGatewayService,
    ).streamTextWithUsage({
      actor: { orgId, userId },
      feature: "exec.brief.generate",
      tier: "standard",
      prompt: {
        system:
          "You are an executive AI assistant. Produce a concise, factual business brief for senior leadership. Cite each data source by module name. Never fabricate metrics not present in the data.",
        user: buildBriefPrompt(sources, uncertaintyNotes),
      },
      maxTokens: 1024,
      charge: true,
      signal,
    });
    const handleCompletion = async () => {
      signal.throwIfAborted();
      const finishReason = await stream.finishReason;
      if (finishReason !== "stop")
        throw new Error("Executive brief generation did not complete");
      const narrative = await stream.text;
      const usage = await stream.totalUsage;
      const promptTokens = usage.inputTokens ?? 0;
      const completionTokens = usage.outputTokens ?? 0;
      const { milliCredits, costUsd } = computeTokenCharge(
        model,
        promptTokens,
        completionTokens,
      );
      const aiUsage: AiUsageMeta = {
        model,
        promptTokens,
        completionTokens,
        totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
        credits: milliToCredits(milliCredits),
        costUsd,
      };
      signal.throwIfAborted();
      await this.saveBrief(orgId, userId, {
        narrative,
        citations,
        sources,
        uncertaintyNotes,
        aiUsage,
      });
    };
    const output = stream.textStream.pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        flush: handleCompletion,
      }),
    );
    return {
      sources: citations,
      stream: createPipeableAiTextStream(output),
    };
  }

  async generate(orgId: string, userId: string): Promise<ExecutiveBriefResult> {
    const { sources, uncertaintyNotes } = await this.resolveContext(orgId);
    const invokeResult = await this.getSvc(
      AiGatewayService,
    ).invokeTextWithUsage({
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
      citations.push(...this.resolveCitations(sources));
    } else {
      uncertaintyNotes.push(
        `Narrative generation failed: ${invokeResult.message}`,
      );
      narrative = "Executive brief generation failed. Please retry.";
    }

    await this.saveBrief(orgId, userId, {
      narrative,
      citations,
      sources,
      uncertaintyNotes,
      aiUsage,
    });

    return {
      narrative,
      citations,
      sources,
      uncertaintyNotes,
      generatedAt: new Date().toISOString(),
      aiUsage: aiUsage ?? null,
    };
  }

  private async saveBrief(
    orgId: string,
    userId: string,
    payload: StoredBriefPayload,
  ): Promise<void> {
    const { narrative, citations, sources, uncertaintyNotes } = payload;
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
        summary: JSON.stringify(payload),
        structured: {
          highlights: citations.map((c) => c.title),
          blockers: uncertaintyNotes,
          nextActions: [],
        },
        citations: snapshotCitations,
      },
      userId,
    );
  }
}

function buildBriefPrompt(
  sources: Record<string, unknown>,
  uncertaintyNotes: string[],
): string {
  const parts: string[] = [
    "Generate an executive business brief based on the following operational data:\n",
  ];

  if (sources.projects && isProjectHealthSummary(sources.projects)) {
    const p = sources.projects;
    parts.push(
      `**Projects (source: /projects):** ${p.total} total projects. Healthy: ${p.healthy}, At Risk: ${p.atRisk}, Critical: ${p.critical}. Average health score: ${p.avgScore}/100.`,
    );
  }

  if (sources.crm) {
    parts.push(`**CRM/Sales (source: /crm):** ${JSON.stringify(sources.crm)}`);
  }

  if (sources.support && isSupportOverview(sources.support)) {
    const s = sources.support;
    parts.push(
      `**Support (source: /support):** Open tickets: ${s.openTickets}, SLA breaches: ${s.slaBreachCount}, Avg first response: ${s.avgFirstResponseMinutes ?? "N/A"} min.`,
    );
  }

  if (uncertaintyNotes.length > 0) {
    parts.push(
      `\n**Data gaps (do not fabricate for these):** ${uncertaintyNotes.join("; ")}`,
    );
  }

  parts.push(
    "\nStructure: 1-2 sentence overall health summary, then one paragraph per module with key metrics, then 3 strategic recommendations. Be concise and factual.",
  );

  return parts.join("\n");
}
