import { createBulkJobSchema, commitBulkJobSchema } from "./reporting-lines-bulk.schemas";
import {
  managerCandidatesQuerySchema,
  reportingLineDetailSchema,
  setReportingLineSchema,
  updateReportingManagerPolicySchema,
} from "./reporting-lines-line.schemas";
import { createReportingManagerRequestSchema } from "./reporting-lines-requests.schemas";

describe("HRM-15 §4 request schemas", () => {
  it("accepts both bulk-job shapes and rejects a body mixing them", () => {
    expect(
      createBulkJobSchema.safeParse({ jobReason: "Q3 reorganisation", rows: [{ employeeEmail: "A@x.com" }] }).success,
    ).toBe(true);
    expect(
      createBulkJobSchema.safeParse({
        jobReason: "Q3 reorganisation",
        employeeUserIds: ["u1"],
        primaryManagerUserId: "m1",
      }).success,
    ).toBe(true);
    expect(
      createBulkJobSchema.safeParse({
        jobReason: "Q3 reorganisation",
        rows: [{ employeeEmail: "a@x.com" }],
        employeeUserIds: ["u1"],
        primaryManagerUserId: "m1",
      }).success,
    ).toBe(false);
  });

  it("requires a job reason of at least ten characters after trimming", () => {
    expect(createBulkJobSchema.safeParse({ jobReason: "  short  ", rows: [{ employeeEmail: "a@x.com" }] }).success).toBe(
      false,
    );
  });

  it("caps a bulk job at 500 rows", () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ employeeEmail: `e${index}@x.com` }));
    expect(createBulkJobSchema.safeParse({ jobReason: "Q3 reorganisation", rows }).success).toBe(false);
    expect(createBulkJobSchema.safeParse({ jobReason: "Q3 reorganisation", rows: rows.slice(0, 500) }).success).toBe(true);
  });

  it("rejects unknown keys on a commit body", () => {
    expect(commitBulkJobSchema.safeParse({ confirmationPhrase: "CONFIRM 12" }).success).toBe(true);
    expect(commitBulkJobSchema.safeParse({ confirmationPhrase: "CONFIRM 12", force: true }).success).toBe(false);
  });

  it("lets PUT carry a null primary for a top-level role and leaves the rule itself to the service", () => {
    expect(setReportingLineSchema.safeParse({ primaryManagerUserId: null }).success).toBe(true);
    expect(setReportingLineSchema.safeParse({ primaryManagerUserId: "m1", effectiveFrom: "2026-13-01" }).success).toBe(
      false,
    );
    expect(
      setReportingLineSchema.safeParse({
        primaryManagerUserId: "m1",
        secondaryManagers: [{ managerUserId: "a" }, { managerUserId: "b" }, { managerUserId: "c" }, { managerUserId: "d" }],
      }).success,
    ).toBe(false);
  });

  it("requires expectedVersion on a policy patch", () => {
    expect(updateReportingManagerPolicySchema.safeParse({ fallbackOrder: "CONFIGURED_MANAGER_THEN_UPLOADER" }).success).toBe(
      false,
    );
    expect(updateReportingManagerPolicySchema.safeParse({ defaultPrimaryManagerUserId: null, expectedVersion: 1 }).success).toBe(
      true,
    );
  });

  it("clamps manager candidates to twenty rather than rejecting a larger limit", () => {
    expect(managerCandidatesQuerySchema.parse({ limit: "80" }).limit).toBe(20);
    expect(managerCandidatesQuerySchema.parse({}).limit).toBe(20);
  });

  it("holds an employee's reason to 20..1000 characters", () => {
    expect(createReportingManagerRequestSchema.safeParse({ reason: "wrong manager" }).success).toBe(false);
    expect(
      createReportingManagerRequestSchema.safeParse({ reason: "My manager changed when I moved teams in July." }).success,
    ).toBe(true);
  });
});

describe("HRM-15 §4.3 line detail", () => {
  it("keeps today's primary fields and adds source, fallback flag and relationship type", () => {
    const entry = {
      lineId: 1,
      managerUserId: "m1",
      managerName: "Manager",
      managerEmail: "m@x.com",
      managerDesignation: null,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      recordedAt: "2026-01-01T00:00:00.000Z",
      recordedBy: null,
      managerState: "active",
      source: "ONBOARDING_FALLBACK",
      isFallback: true,
      fallbackConfirmedAt: null,
      changeReason: null,
      relationshipType: "PRIMARY",
    };
    const detail = {
      userId: "u1",
      current: entry,
      upcoming: [],
      history: [entry],
      secondary: [],
      topLevel: null,
      primaryChangesLast24h: 0,
      changeThreshold: 3,
      maxSecondaryManagers: 0,
      pendingRequest: null,
      permittedActions: { manage: true, review: false, override: false },
    };

    expect(reportingLineDetailSchema.safeParse(detail).success).toBe(true);
    expect(reportingLineDetailSchema.safeParse({ ...detail, current: { ...entry, source: undefined } }).success).toBe(false);
  });
});
