import type { ManagerAssignmentCheck, ReportingManagerPolicy } from "../../../directory/reporting-line.types";
import { checkHireSecondaries, type HireSecondaryInput } from "./bulk-onboarding-secondaries";

const policy = (max: number): ReportingManagerPolicy => ({
  orgId: "org-1",
  isConfigured: true,
  maxSecondaryManagersPerEmployee: max,
  defaultPrimaryManagerUserId: null,
  fallbackOrder: "CONFIGURED_MANAGER_THEN_UPLOADER",
  requireReasonAfterChanges: 3,
  allowTopLevelWithoutManager: true,
  version: 1,
  updatedAt: null,
});

const person = (userId: string, email: string) => ({ userId, name: userId, email, designation: null, employmentId: 1, state: "active" as const });

function input(overrides: Partial<HireSecondaryInput> = {}): HireSecondaryInput {
  return {
    hire: { email: "hire@example.com", userId: null, topLevelReason: null, effectiveFrom: "2026-10-01" },
    primary: { userId: "boss", email: "boss@example.com" },
    secondaryEmails: ["lead@example.com"],
    people: new Map([["lead@example.com", person("lead", "lead@example.com")], ["boss@example.com", person("boss", "boss@example.com")]]),
    roster: new Set(["hire@example.com", "peer@example.com"]),
    policy: policy(2),
    managerChecks: new Map<string, ManagerAssignmentCheck>([
      ["lead", { ok: true, managerEmploymentId: 11 }],
      ["boss", { ok: true, managerEmploymentId: 10 }],
    ]),
    managerEmployments: new Map(),
    ...overrides,
  };
}

describe("checkHireSecondaries — the relationship rules, applied to a hire who does not exist yet", () => {
  it("accepts an eligible existing secondary and an in-file one, resolving only the existing user id", () => {
    expect(checkHireSecondaries(input({ secondaryEmails: ["lead@example.com", "peer@example.com"] }))).toEqual({
      ok: true,
      secondaries: [
        { email: "lead@example.com", userId: "lead", name: "lead" },
        { email: "peer@example.com", userId: null, name: null },
      ],
    });
  });

  it("uses the shared cap, counting in-file secondaries too", () => {
    expect(checkHireSecondaries(input({ policy: policy(1), secondaryEmails: ["lead@example.com", "peer@example.com"] }))).toMatchObject({
      ok: false,
      code: "SECONDARY_CAP_EXCEEDED",
    });
  });

  it("refuses the hire as their own secondary, a duplicate, and the primary again, with the shared codes", () => {
    expect(checkHireSecondaries(input({ secondaryEmails: ["hire@example.com"] }))).toMatchObject({ ok: false, code: "SELF_REFERENCE" });
    expect(checkHireSecondaries(input({ secondaryEmails: ["lead@example.com", "lead@example.com"] }))).toMatchObject({ ok: false, code: "SECONDARY_DUPLICATE" });
    expect(checkHireSecondaries(input({ secondaryEmails: ["boss@example.com"] }))).toMatchObject({ ok: false, code: "SECONDARY_DUPLICATES_PRIMARY" });
    expect(
      checkHireSecondaries(input({ primary: { userId: null, email: "peer@example.com" }, secondaryEmails: ["peer@example.com"] })),
    ).toMatchObject({ ok: false, code: "SECONDARY_DUPLICATES_PRIMARY" });
  });

  it("refuses an existing secondary the manager check refuses, and one who leaves before the effective date", () => {
    const refused = new Map<string, ManagerAssignmentCheck>([
      ["lead", { ok: false, reason: "manager-inactive", message: "lead is inactive." }],
      ["boss", { ok: true, managerEmploymentId: 10 }],
    ]);
    expect(checkHireSecondaries(input({ managerChecks: refused }))).toMatchObject({ ok: false, code: "MANAGER_NOT_ELIGIBLE" });
    const leaving = new Map([[11, { userId: "lead", employmentId: 11, lifecycleStatus: "ACTIVE", joiningDate: null, lastWorkingDay: "2026-09-01", exitDate: null }]]);
    expect(checkHireSecondaries(input({ managerEmployments: leaving }))).toMatchObject({ ok: false, code: "MANAGER_NOT_ELIGIBLE" });
  });

  it("keeps the in-file check local: an email that is neither a member nor a row is MANAGER_NOT_FOUND", () => {
    expect(checkHireSecondaries(input({ secondaryEmails: ["ghost@example.com"] }))).toMatchObject({ ok: false, code: "MANAGER_NOT_FOUND" });
  });

  it("refuses secondaries on a top-level row", () => {
    expect(
      checkHireSecondaries(input({ primary: null, hire: { email: "hire@example.com", userId: null, topLevelReason: "Founder", effectiveFrom: "2026-10-01" } })),
    ).toMatchObject({ ok: false, code: "TOP_LEVEL_WITH_MANAGER" });
  });
});
