import {
  testRunDetailSchema,
  testRunResultPageSchema,
} from "./dto/qa-response.schemas";

const dates = {
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const run = {
  id: 7,
  orgId: "org-1",
  projectId: 42,
  runNumber: 3,
  name: "Release validation",
  cycleId: null,
  releaseId: null,
  environment: "staging",
  browserDevice: "Chrome",
  testerId: null,
  testerMembershipId: null,
  status: "in_progress" as const,
  startedAt: null,
  completedAt: null,
  createdBy: "user-1",
  ...dates,
  deletedAt: null,
};

const result = {
  id: 11,
  orgId: "org-1",
  projectId: 42,
  runId: 7,
  testCaseId: 9,
  status: "failed" as const,
  notes: "Needs follow-up",
  executedBy: "user-2",
  executedAt: dates.updatedAt,
  linkedWorkItemId: null,
  ...dates,
};

describe("QA run response contracts", () => {
  it("accepts getRun results with tenant fields and nested test case metadata", () => {
    expect(
      testRunDetailSchema.parse({
        ...run,
        results: [
          {
            ...result,
            testCase: { caseNumber: 12, title: "Checkout", priority: "high" },
          },
        ],
      }).results[0],
    ).toEqual({
      ...result,
      testCase: { caseNumber: 12, title: "Checkout", priority: "high" },
    });
  });

  it("keeps listRunResults on the flat result contract", () => {
    expect(
      testRunResultPageSchema.parse({ data: [result], hasMore: false, nextCursor: null }),
    ).toEqual({ data: [result], hasMore: false, nextCursor: null });
  });
});
