import { Test } from "@nestjs/testing";
import { ServerResponse, IncomingMessage } from "node:http";
import { Socket } from "node:net";

jest.mock("node:stream/promises", () => ({
  pipeline: jest.fn(async (stream: AsyncIterable<string>) => {
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks.join("");
  }),
}));

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { ExecutiveBriefService } from "./executive-brief.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiSummariesService } from "../../summaries/ai-summaries.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsAnalyticsService } from "../../../build/core";
import { CrmSalesDashboardService } from "../../../crm/core/crm-sales-dashboard.service";
import { SupportReportsService } from "../../../support/core/support-reports.service";

const ORG = "org-1";
const USER = "user-1";

const TEST_AI_USAGE = {
  model: "gemini",
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  credits: 1,
  costUsd: 0.001,
};

function makeGateway(ok: boolean) {
  return {
    streamTextWithUsage: jest.fn().mockResolvedValue({
      model: "gpt-4o-mini",
      stream: {
        textStream: new ReadableStream<string>({ start(controller) {
          controller.enqueue("The org ");
          controller.enqueue("is healthy.");
          controller.close();
        } }),
        text: Promise.resolve("The org is healthy."),
        finishReason: Promise.resolve("stop"),
        totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      },
    }),
    invokeTextWithUsage: jest.fn().mockResolvedValue(
      ok
        ? { ok: true, data: "The org is healthy.", aiUsage: TEST_AI_USAGE }
        : { ok: false, kind: "quota_exceeded", message: "Quota exceeded", correlationId: "c1" },
    ),
  };
}

function makeSummaries() {
  return {
    saveSnapshot: jest.fn().mockResolvedValue({ id: 1 }),
    getLatestWithDiff: jest.fn().mockResolvedValue(null),
  };
}

function makeProjectsAnalytics(fail = false) {
  return {
    getOrgProjectHealthSummary: fail
      ? jest.fn().mockRejectedValue(new Error("DB error"))
      : jest.fn().mockResolvedValue({ total: 5, healthy: 3, atRisk: 1, critical: 1, avgScore: 72 }),
  };
}

function makeCrmDashboard(fail = false) {
  return {
    getSalesDashboard: fail
      ? jest.fn().mockRejectedValue(new Error("CRM down"))
      : jest.fn().mockResolvedValue({ pipeline: { value: 100000 } }),
  };
}

function makeSupportReports(fail = false) {
  return {
    getOverview: fail
      ? jest.fn().mockRejectedValue(new Error("Support down"))
      : jest.fn().mockResolvedValue({ openTickets: 12, slaBreachCount: 2, avgFirstResponseMinutes: 30 }),
  };
}

async function buildSvc(opts: {
  gatewayOk?: boolean;
  projectsFail?: boolean;
  crmFail?: boolean;
  supportFail?: boolean;
}) {
  const crmDashboard = makeCrmDashboard(opts.crmFail);
  const supportReports = makeSupportReports(opts.supportFail);
  const gateway = makeGateway(opts.gatewayOk ?? true);
  const projectsAnalytics = makeProjectsAnalytics(opts.projectsFail);

  const moduleRef = {
    get: jest.fn().mockImplementation((token: unknown) => {
      if (token === CrmSalesDashboardService) return crmDashboard;
      if (token === SupportReportsService) return supportReports;
      if (token === AiGatewayService) return gateway;
      if (token === ProjectsAnalyticsService) return projectsAnalytics;
      return {};
    }),
  };

  const module = await Test.createTestingModule({
    providers: [
      ExecutiveBriefService,
      { provide: DRIZZLE, useValue: {} },
      { provide: AiSummariesService, useValue: makeSummaries() },
    ],
  }).compile();

  const svc = module.get(ExecutiveBriefService);
  // Override ModuleRef after construction
  Object.defineProperty(svc, "moduleRef", { value: moduleRef, writable: false });
  return svc;
}

describe("ExecutiveBriefService", () => {
  it("streams without saving a draft, then persists before successful completion", async () => {
    const svc = await buildSvc({});
    const save = jest.spyOn(svc["summaries"], "saveSnapshot");
    const result = await svc.streamGenerate(ORG, USER, new AbortController().signal);
    expect(save).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(3);
    await result.stream.pipeTextStreamToResponse(new ServerResponse(new IncomingMessage(new Socket())));
    expect(save).toHaveBeenCalledWith(ORG, "executive_brief", ORG, expect.objectContaining({
      summary: expect.stringContaining("The org is healthy."),
    }), USER);
  });

  it("does not publish a successful completion when snapshot persistence fails", async () => {
    const svc = await buildSvc({});
    jest.spyOn(svc["summaries"], "saveSnapshot").mockRejectedValue(new Error("snapshot unavailable"));
    const result = await svc.streamGenerate(ORG, USER, new AbortController().signal);
    await expect(result.stream.pipeTextStreamToResponse(new ServerResponse(new IncomingMessage(new Socket()))))
      .rejects.toThrow("snapshot unavailable");
  });

  it("does not save a partial stream after cancellation", async () => {
    const svc = await buildSvc({});
    const save = jest.spyOn(svc["summaries"], "saveSnapshot");
    const abort = new AbortController();
    const result = await svc.streamGenerate(ORG, USER, abort.signal);
    abort.abort();
    await expect(result.stream.pipeTextStreamToResponse(new ServerResponse(new IncomingMessage(new Socket()))))
      .rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it("aggregates all sources and returns narrative + citations", async () => {
    const svc = await buildSvc({});
    const result = await svc.generate(ORG, USER);
    expect(result.narrative).toBe("The org is healthy.");
    expect(result.citations.map((c) => c.id)).toEqual(expect.arrayContaining(["projects", "crm", "support"]));
    expect(result.uncertaintyNotes).toHaveLength(0);
    expect(result.aiUsage).toEqual(TEST_AI_USAGE);
  });

  it("surfaces uncertainty when a source fails, never crashes", async () => {
    const svc = await buildSvc({ crmFail: true, supportFail: true });
    const result = await svc.generate(ORG, USER);
    expect(result.uncertaintyNotes.some((n) => n.includes("CRM"))).toBe(true);
    expect(result.uncertaintyNotes.some((n) => n.includes("Support"))).toBe(true);
    expect(result.citations.map((c) => c.id)).toContain("projects");
    expect(result.citations.map((c) => c.id)).not.toContain("crm");
  });

  it("records uncertainty when projects fail", async () => {
    const svc = await buildSvc({ projectsFail: true });
    const result = await svc.generate(ORG, USER);
    expect(result.uncertaintyNotes.some((n) => n.includes("Projects"))).toBe(true);
  });

  it("records uncertainty when AI gateway fails", async () => {
    const svc = await buildSvc({ gatewayOk: false });
    const result = await svc.generate(ORG, USER);
    expect(result.uncertaintyNotes.some((n) => n.includes("Narrative generation failed"))).toBe(true);
    expect(result.narrative).toBe("Executive brief generation failed. Please retry.");
  });

  it("getLatest delegates to summaries", async () => {
    const svc = await buildSvc({});
    const spy = jest.spyOn(svc["summaries"], "getLatestWithDiff").mockResolvedValue(null);
    await svc.getLatest(ORG);
    expect(spy).toHaveBeenCalledWith(ORG, "executive_brief", ORG);
  });
});
