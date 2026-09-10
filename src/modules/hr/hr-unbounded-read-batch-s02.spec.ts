import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("S02 HR collection read caps", () => {
  const sourceRoot = resolve(__dirname);
  const cappedQueries: Array<[string, string]> = [
    ["time/attendance-clock.service.ts", "from(geofences)"],
    ["time/attendance-event-writer.service.ts", "from(attendanceEventLocators)"],
    ["time/leaves-page.service.ts", "from(leaveBalances)"],
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
    ["workflows/hr-workflow-step-runner.service.ts", "from(hrWorkflowSteps)"],
    ["performance/review-cycles.service.ts", "performanceReviews.findMany"],
    ["recruitment/recruitment-calibration.service.ts", ".findMany("],
    ["recruitment/recruitment-candidate-ai.service.ts", "interviews.findMany"],
    ["interviews/hr-interviews.service.ts", "interviews.findMany"],
    ["recruitment/recruitment-offers.service.ts", "candidateOffers.findMany"],
    ["directory/assets.service.ts", "from(assetReturns)"],
    ["enterprise-comp/payroll-compliance.service.ts", "inArray(hrPayrollComplianceTasks.name"],
    ["enterprise-ops/accommodations/accommodations.service.ts", "from(hrAccommodationTasks)"],
    ["governance/legal-holds/legal-holds.service.ts", "from(hrLegalHoldItems)"],
    ["governance/positions/positions-taxonomy.service.ts", "from(hrPositionStatuses)"],
    ["governance/positions/positions-transitions.service.ts", "from(hrPositionTransitions)"],
    ["performance/engagement-badges.service.ts", "from(hrBadges)"],
    ["performance/engagement-mood-polls.service.ts", "groupBy(hrPollVotes.optionIndex)"],
    ["performance/engagement.service.ts", "from(feedbackRequests)"],
    ["performance/feedback.service.ts", "from(feedbackCycles)"],
    ["recruitment/recruitment-candidate-docs.service.ts", "from(candidateDocuments)"],
    ["time/biometric.service.ts", "from(biometricDevices)"],
    ["time/overtime.service.ts", "from(compOffBalances)"],
  ];

  it.each(cappedQueries)("caps %s (%s) close to the query", (relativePath, anchor) => {
    const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 360)).toMatch(/limit\s*:\s*(100|query\.limit)|\.limit\((?:1|20|100|input\.templateIds\.length|presetNames\.length)\)|groupBy\(/);
  });

  const auditedBatch: Array<[string, string]> = [
    ["analytics-plus/hr-analytics-plus.service.ts", "hrHeadcountPlans.fiscalYear"],
    ["automations/hr-automation-engine.service.ts", "hrAutomationRules.findMany"],
    ["benefits/hr-benefits-enrollment.service.ts", "hrDependents.name"],
    ["config/hr-holidays.service.ts", "organizationMembers.orgId"],
    ["core/hr-custom-fields.service.ts", "customFieldDefinitions.displayOrder"],
    ["core/hr-sensitive-record-compat.ts", "sourceOrdinal"],
    ["directory/employee-analytics.service.ts", "inArray(users.id, directReportIds)"],
    ["directory/bulk-onboarding/bulk-onboarding-departments.ts", "orgUnits.kind"],
    ["directory/employee-mutations.service.ts", "eq(employeeSkills.userId, targetUserId)"],
    ["directory/employee-skills-page-query.ts", ".limit(Math.max(1, employeeUserIds.length"],
    ["directory/employees.service.ts", "projectMembers.orgId"],
    ["directory/org-structure.service.ts", "orgUnits.findMany"],
    ["directory/salary-profile-seed.helper.ts", "salaryComponents.sortOrder"],
  ];

  it.each(auditedBatch)("keeps the audited S02 read bounded in %s", (relativePath, anchor) => {
    const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThanOrEqual(0);
    const window = source.slice(Math.max(0, start - 180), start + 1000);
    const boundedLiteral =
      /limit\s*:\s*(100|500|1000)|\.limit\((?:100|200|500|1000|directReportIds\.length|Math\.max\(1, employeeUserIds\.(?:size|length) \* MAX_SKILLS_PER_EMPLOYEE\))\)/;
    if (boundedLiteral.test(window)) return;

    // A keyset drain reads every row a truncating cap would have dropped, so it is the
    // stronger remedy — but only while BOTH bounds are present: the page size caps each
    // query, and the page count is what stops the loop.
    expect(window).toMatch(/\.limit\(HR_SCAN_PAGE\)/);
    expect(source).toMatch(/HR_SCAN_MAX_PAGES/);
  });

  it("caps the direct-report id list the manager scorecard sizes its read from", () => {
    const source = readFileSync(
      resolve(sourceRoot, "../directory/employment-facts.service.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /async getDirectReportUserIds[\s\S]{0,2000}\.limit\(DIRECT_REPORT_ID_CAP\)/,
    );
    expect(source).toMatch(/DIRECT_REPORT_ID_CAP\s*=\s*\d+/);
  });

  it("continues attendance history with tenant-scoped id batches", () => {
    const source = readFileSync(resolve(sourceRoot, "time/attendance-summary.service.ts"), "utf8");
    expect(source).toMatch(/gt\(attendance\.id, afterId\)[\s\S]{0,500}\.limit\(batchSize\)/);
    expect(source).toMatch(/gt\(hrAttendanceRegularizations\.id, afterId\)[\s\S]{0,500}\.limit\(batchSize\)/);
  });

  it("counts parallel approvals without materializing action rows", () => {
    const source = readFileSync(resolve(sourceRoot, "workflows/hr-workflow-step-runner.service.ts"), "utf8");
    expect(source).toMatch(/select\(\{ approvedCount: count\(\) \}\)/);
    expect(source).not.toMatch(/const actionsForStep = await/);
  });
});
