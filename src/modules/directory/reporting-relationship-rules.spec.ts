import { evaluateRelationshipCommand, type RelationshipRuleContext } from "./reporting-relationship-rules";
import type { RelationshipRow, SubjectEmployment } from "./reporting-line-queries";
import type { ManagerAssignmentCheck, ReportingManagerPolicy, SetRelationshipsCommand } from "./reporting-line.types";

const ORG = "org-1";
const SUBJECT = "u-subject";
const BOSS = "u-boss";
const OTHER = "u-other";
const THIRD = "u-third";
const FOURTH = "u-fourth";

const EMPLOYMENTS: Record<string, number> = { [SUBJECT]: 10, [BOSS]: 20, [OTHER]: 30, [THIRD]: 40, [FOURTH]: 50 };

function policy(overrides: Partial<ReportingManagerPolicy> = {}): ReportingManagerPolicy {
  return {
    orgId: ORG,
    isConfigured: true,
    maxSecondaryManagersPerEmployee: 3,
    defaultPrimaryManagerUserId: null,
    fallbackOrder: "CONFIGURED_MANAGER_THEN_UPLOADER",
    requireReasonAfterChanges: 3,
    allowTopLevelWithoutManager: true,
    version: 1,
    updatedAt: null,
    ...overrides,
  };
}

function employment(userId: string, overrides: Partial<SubjectEmployment> = {}): SubjectEmployment {
  return { userId, employmentId: EMPLOYMENTS[userId], lifecycleStatus: "ACTIVE", joiningDate: "2025-01-01", lastWorkingDay: null, exitDate: null, ...overrides };
}

function eligible(...userIds: string[]): Map<string, ManagerAssignmentCheck> {
  return new Map(userIds.map((userId) => [userId, { ok: true, managerEmploymentId: EMPLOYMENTS[userId] }]));
}

function primaryLine(managerUserId: string): RelationshipRow {
  return {
    lineId: 1,
    employmentId: EMPLOYMENTS[SUBJECT],
    managerEmploymentId: EMPLOYMENTS[managerUserId],
    managerUserId,
    primary: true,
    label: null,
    source: "MANUAL",
    effectiveFrom: "2026-01-01",
    effectiveTo: "infinity",
  };
}

function context(overrides: Partial<RelationshipRuleContext> = {}): RelationshipRuleContext {
  return {
    policy: policy(),
    subject: employment(SUBJECT),
    managerChecks: eligible(BOSS, OTHER, THIRD, FOURTH),
    managerEmployments: new Map([BOSS, OTHER, THIRD, FOURTH].map((userId) => [EMPLOYMENTS[userId], employment(userId)])),
    currentPrimary: null,
    currentSecondary: [],
    changesLast24h: 0,
    cyclic: false,
    elevated: false,
    system: false,
    ...overrides,
  };
}

function command(overrides: Partial<SetRelationshipsCommand> = {}): SetRelationshipsCommand {
  return {
    orgId: ORG,
    actor: { orgId: ORG, userId: "u-hr", isOrgOwner: false },
    subjectUserId: SUBJECT,
    primaryManagerUserId: BOSS,
    effectiveFrom: "2026-09-26",
    source: "MANUAL",
    ...overrides,
  };
}

function codes(cmd: SetRelationshipsCommand, ctx: RelationshipRuleContext = context()): string[] {
  return evaluateRelationshipCommand(cmd, ctx).issues.map((issue) => issue.code);
}

describe("evaluateRelationshipCommand — primary manager", () => {
  it("accepts an eligible manager and reports the resolved employment", () => {
    const result = evaluateRelationshipCommand(command(), context());
    expect(result.ok).toBe(true);
    expect(result.primaryManagerEmploymentId).toBe(EMPLOYMENTS[BOSS]);
    expect(result.primaryChanged).toBe(true);
  });

  it("refuses the employee as their own manager", () => {
    expect(codes(command({ primaryManagerUserId: SUBJECT }))).toEqual(["SELF_REFERENCE"]);
  });

  it("refuses an out-of-tenant or missing manager as not found, without saying which", () => {
    const ctx = context({
      managerChecks: new Map([[BOSS, { ok: false, reason: "manager-not-in-organization", message: "not a member" }]]),
    });
    expect(codes(command(), ctx)).toEqual(["MANAGER_NOT_FOUND"]);
  });

  it.each(["manager-inactive", "manager-never-accepted", "manager-has-no-employment", "manager-exited"] as const)(
    "refuses an ineligible manager (%s) as not eligible",
    (reason) => {
      const ctx = context({ managerChecks: new Map([[BOSS, { ok: false, reason, message: reason }]]) });
      expect(codes(command(), ctx)).toEqual(["MANAGER_NOT_ELIGIBLE"]);
    },
  );

  it("refuses a manager who joins after the effective date, and accepts one who joined before", () => {
    const late = context({ managerEmployments: new Map([[EMPLOYMENTS[BOSS], employment(BOSS, { joiningDate: "2026-10-01" })]]) });
    expect(codes(command(), late)).toEqual(["MANAGER_NOT_ELIGIBLE"]);
    expect(codes(command({ effectiveFrom: "2026-10-01" }), late)).toEqual([]);
  });

  it("refuses a manager who leaves before the effective date, judged against their scheduled exit", () => {
    const leaving = context({ managerEmployments: new Map([[EMPLOYMENTS[BOSS], employment(BOSS, { lastWorkingDay: "2026-09-30" })]]) });
    expect(codes(command({ effectiveFrom: "2026-10-01" }), leaving)).toEqual(["MANAGER_NOT_ELIGIBLE"]);
    expect(codes(command({ effectiveFrom: "2026-09-30" }), leaving)).toEqual([]);
  });

  it("refuses a cycle the database found, and only then", () => {
    expect(codes(command(), context({ cyclic: true }))).toEqual(["PRIMARY_CYCLE"]);
    expect(codes(command(), context({ cyclic: false }))).toEqual([]);
  });

  it("treats an exited or unknown subject as not found", () => {
    expect(codes(command(), context({ subject: undefined }))).toEqual(["EMPLOYEE_NOT_FOUND"]);
    expect(codes(command(), context({ subject: employment(SUBJECT, { lifecycleStatus: "EXITED" }) }))).toEqual(["EMPLOYEE_NOT_FOUND"]);
    expect(codes(command(), context({ subject: employment(SUBJECT, { lifecycleStatus: "ONBOARDING" }) }))).toEqual([]);
  });
});

describe("evaluateRelationshipCommand — effective dates", () => {
  it.each(["2026-09-26", "2099-01-01", "2025-06-30"])("accepts the calendar date %s (same-day, future, back-dated)", (effectiveFrom) => {
    expect(codes(command({ effectiveFrom }))).toEqual([]);
  });

  it.each(["2026-02-30", "26-09-2026", "tomorrow"])("refuses %s", (effectiveFrom) => {
    expect(codes(command({ effectiveFrom }))).toContain("INVALID_EFFECTIVE_DATE");
  });

  it("refuses a bounded line that ends before it starts, and accepts a one-day line", () => {
    expect(codes(command({ effectiveTo: "2026-09-25" }))).toEqual(["INVALID_EFFECTIVE_DATE"]);
    expect(codes(command({ effectiveTo: "2026-09-26" }))).toEqual([]);
  });
});

describe("evaluateRelationshipCommand — top-level roles (D3)", () => {
  it("accepts no primary manager with a reason", () => {
    const result = evaluateRelationshipCommand(command({ primaryManagerUserId: null, topLevelReason: "Founder and CEO" }), context());
    expect(result.ok).toBe(true);
    expect(result.primaryManagerEmploymentId).toBeNull();
  });

  it("requires a non-blank reason", () => {
    expect(codes(command({ primaryManagerUserId: null, topLevelReason: "   " }))).toEqual(["TOP_LEVEL_REASON_REQUIRED"]);
    expect(codes(command({ primaryManagerUserId: null }))).toEqual(["TOP_LEVEL_REASON_REQUIRED"]);
  });

  it("refuses a top-level reason alongside a primary manager", () => {
    expect(codes(command({ topLevelReason: "Founder" }))).toEqual(["TOP_LEVEL_WITH_MANAGER"]);
  });

  it("refuses secondary managers on a top-level employee", () => {
    expect(codes(command({ primaryManagerUserId: null, topLevelReason: "Founder", secondary: [{ managerUserId: OTHER }] }))).toEqual([
      "TOP_LEVEL_WITH_MANAGER",
    ]);
  });

  it("refuses a top-level role when the policy forbids them", () => {
    const ctx = context({ policy: policy({ allowTopLevelWithoutManager: false }) });
    expect(codes(command({ primaryManagerUserId: null, topLevelReason: "Founder" }), ctx)).toEqual(["TOP_LEVEL_NOT_ALLOWED"]);
  });
});

describe("evaluateRelationshipCommand — secondary managers", () => {
  const three = [{ managerUserId: OTHER }, { managerUserId: THIRD }, { managerUserId: FOURTH }];

  it.each([0, 1, 2, 3])("enforces a cap of %i exactly at the boundary", (cap) => {
    const ctx = context({ policy: policy({ maxSecondaryManagersPerEmployee: cap }) });
    expect(codes(command({ secondary: three.slice(0, cap) }), ctx)).toEqual([]);
    if (cap < 3) expect(codes(command({ secondary: three.slice(0, cap + 1) }), ctx)).toEqual(["SECONDARY_CAP_EXCEEDED"]);
  });

  it("refuses the employee, the primary manager and a repeated manager as secondaries", () => {
    expect(codes(command({ secondary: [{ managerUserId: SUBJECT }] }))).toEqual(["SELF_REFERENCE"]);
    expect(codes(command({ secondary: [{ managerUserId: BOSS }] }))).toEqual(["SECONDARY_DUPLICATES_PRIMARY"]);
    expect(codes(command({ secondary: [{ managerUserId: OTHER }, { managerUserId: OTHER }] }))).toEqual(["SECONDARY_DUPLICATE"]);
  });

  it("refuses an ineligible secondary manager", () => {
    const checks = eligible(BOSS);
    checks.set(OTHER, { ok: false, reason: "manager-exited", message: "exited" });
    expect(codes(command({ secondary: [{ managerUserId: OTHER }] }), context({ managerChecks: checks }))).toEqual(["MANAGER_NOT_ELIGIBLE"]);
  });

  it("refuses a new primary who is already a current secondary when secondaries are left unchanged", () => {
    const secondary: RelationshipRow = { ...primaryLine(OTHER), primary: false, lineId: 2, managerEmploymentId: EMPLOYMENTS[BOSS], managerUserId: BOSS };
    expect(codes(command(), context({ currentSecondary: [secondary] }))).toEqual(["SECONDARY_DUPLICATES_PRIMARY"]);
    expect(codes(command({ secondary: [] }), context({ currentSecondary: [secondary] }))).toEqual([]);
  });
});

describe("evaluateRelationshipCommand — repeated-change guard (D4)", () => {
  it("lets the first three primary changes in 24 hours through with no reason", () => {
    for (const changesLast24h of [0, 1, 2])
      expect(evaluateRelationshipCommand(command(), context({ changesLast24h })).ok).toBe(true);
  });

  it("requires a 10-character reason and elevated authority for the fourth change", () => {
    const ctx = context({ changesLast24h: 3, currentPrimary: primaryLine(OTHER) });
    expect(codes(command(), ctx)).toEqual(["CHANGE_REASON_REQUIRED", "ELEVATED_AUTHORITY_REQUIRED"]);
    expect(codes(command({ reason: "  short   r " }), { ...ctx, elevated: true })).toEqual(["CHANGE_REASON_REQUIRED"]);
    expect(codes(command({ reason: "Reorganisation of the sales team" }), ctx)).toEqual(["ELEVATED_AUTHORITY_REQUIRED"]);
    const allowed = evaluateRelationshipCommand(command({ reason: "Reorganisation of the sales team" }), { ...ctx, elevated: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings).toContain("PRIMARY_CHANGE_THRESHOLD_EXCEEDED");
  });

  it("counts 10 non-whitespace characters, not 10 characters", () => {
    const ctx = context({ changesLast24h: 3, elevated: true });
    expect(codes(command({ reason: "a b c d e f g h i" }), ctx)).toEqual(["CHANGE_REASON_REQUIRED"]);
    expect(codes(command({ reason: "a b c d e f g h i j" }), ctx)).toEqual([]);
  });

  it("follows the policy's threshold rather than a fixed three", () => {
    const ctx = context({ changesLast24h: 1, policy: policy({ requireReasonAfterChanges: 1 }) });
    expect(codes(command(), ctx)).toContain("CHANGE_REASON_REQUIRED");
  });

  it("does not guard a write that leaves the primary manager unchanged", () => {
    const ctx = context({ changesLast24h: 9, currentPrimary: primaryLine(BOSS) });
    const result = evaluateRelationshipCommand(command(), ctx);
    expect(result.ok).toBe(true);
    expect(result.primaryChanged).toBe(false);
  });

  it("lets a system actor past the elevated-role requirement but not the reason requirement", () => {
    const system = context({ changesLast24h: 5, system: true });
    expect(codes(command({ actor: { orgId: ORG, system: "effective-change-applier" } }), system)).toEqual(["CHANGE_REASON_REQUIRED"]);
    expect(codes(command({ actor: { orgId: ORG, system: "effective-change-applier" }, reason: "Scheduled promotion change" }), system)).toEqual([]);
  });

  it("skips the guard entirely when the caller says so", () => {
    expect(codes(command({ skipFrequencyGuard: true }), context({ changesLast24h: 7 }))).toEqual([]);
  });

  it("requires a reason and elevated authority for an emergency change, even with no prior changes", () => {
    expect(codes(command({ emergency: true }))).toEqual(["CHANGE_REASON_REQUIRED", "ELEVATED_AUTHORITY_REQUIRED"]);
    const allowed = evaluateRelationshipCommand(command({ emergency: true, reason: "Manager left without notice" }), context({ elevated: true }));
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings).toContain("EMERGENCY_OVERRIDE");
  });

  it("never lets a system actor make an emergency change", () => {
    const ctx = context({ system: true });
    expect(codes(command({ emergency: true, reason: "Manager left without notice" }), ctx)).toEqual(["ELEVATED_AUTHORITY_REQUIRED"]);
  });
});
