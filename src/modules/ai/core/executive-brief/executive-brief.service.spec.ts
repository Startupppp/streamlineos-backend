import { Test } from "@nestjs/testing";
import { ExecutiveBriefService } from "./executive-brief.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiSummariesService } from "../../summaries/ai-summaries.service";
import { ProjectsAnalyticsService } from "../../../build/core/projects-analytics.service";
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
      { provide: AiSummariesService, useValue: makeSummaries() },
    ],
  }).compile();

  const svc = module.get(ExecutiveBriefService);
  // Override ModuleRef after construction
  Object.defineProperty(svc, "moduleRef", { value: moduleRef, writable: false });
  return svc;
}

describe("ExecutiveBriefService", () => {
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
