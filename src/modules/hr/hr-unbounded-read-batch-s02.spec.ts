import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("S02 HR collection read caps", () => {
  const sourceRoot = resolve(__dirname);
  const cappedQueries: Array<[string, string]> = [
    ["config/hr-holidays.service.ts", "holidays.findMany"],
    ["interviews/hr-scorecards.service.ts", "scorecardTemplates.findMany"],
    ["performance/kpis.service.ts", "competencyFrameworks.findMany"],
    ["interviews/hr-hiring-flows.service.ts", "hiringFlowRounds.findMany"],
    ["recruitment/recruitment-referral-checks.service.ts", "candidateReferenceChecks.findMany"],
    ["recruitment/recruitment-candidate-vault.service.ts", "candidateDocumentsVault.findMany"],
    ["recruitment/recruitment-candidate-ops.service.ts", "candidateSlaTracking.findMany"],
    ["time/leaves-page.service.ts", "leaveTypes.findMany"],
    ["onboarding/flow/guided-tour.service.ts", "guidedTours.findMany"],
    ["onboarding/flow/module-checklist.service.ts", "moduleSetupChecklists.findMany"],
    ["workflows/hr-workflow-engine.service.ts", "hrWorkflowStepActions.findMany"],
    ["performance/review-cycles.service.ts", "performanceReviews.findMany"],
    ["recruitment/recruitment-calibration.service.ts", ".findMany("],
    ["recruitment/recruitment-candidate-ai.service.ts", "interviews.findMany"],
    ["interviews/hr-interviews.service.ts", "interviews.findMany"],
    ["recruitment/recruitment-offers.service.ts", "candidateOffers.findMany"],
  ];

  it.each(cappedQueries)("caps %s (%s) close to the query", (relativePath, anchor) => {
    const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 260)).toMatch(/limit\s*:\s*(100|query\.limit)|\.limit\(100\)/);
  });
});
