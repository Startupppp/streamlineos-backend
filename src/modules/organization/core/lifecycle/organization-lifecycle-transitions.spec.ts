import type { OrganizationSagaKind } from "../../../../db/schema/common/organization-lifecycle";
import {
  assertTransitionAllowed,
  SAGA_STEPS,
  TRANSITION_TABLE,
  type OrgStatus,
} from "./organization-lifecycle-transitions";

describe("TRANSITION_TABLE", () => {
  it("covers every saga kind", () => {
    const expected: OrganizationSagaKind[] = [
      "CREATE",
      "ARCHIVE",
      "RESTORE",
      "EXPORT",
      "OWNERSHIP_TRANSFER",
      "PURGE_SCHEDULE",
      "PURGE_CANCEL",
      "LEGAL_HOLD",
      "LEGAL_HOLD_RELEASE",
      "TERMINAL_DELETE",
    ];
    for (const kind of expected) {
      expect(TRANSITION_TABLE[kind]).toBeDefined();
    }
  });

  it("SAGA_STEPS covers every saga kind with at least one step", () => {
    const kinds = Object.keys(TRANSITION_TABLE) as OrganizationSagaKind[];
    for (const kind of kinds) {
      expect(SAGA_STEPS[kind].length).toBeGreaterThan(0);
    }
  });

  it("CREATE steps match the required list", () => {
    expect(SAGA_STEPS.CREATE).toEqual([
      "reserve-identity",
      "reserve-placement",
      "bootstrap-cell-organization",
      "bootstrap-owner-membership",
      "activate-directory-projection",
    ]);
  });
});

describe("assertTransitionAllowed — legal hold", () => {
  it("blocks PURGE_SCHEDULE when a legal hold is active", () => {
    const result = assertTransitionAllowed("PURGE_SCHEDULE", "ACTIVE", { hasActiveLegalHold: true });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("legal hold");
  });

  it("blocks TERMINAL_DELETE when a legal hold is active", () => {
    const result = assertTransitionAllowed("TERMINAL_DELETE", "ACTIVE", { hasActiveLegalHold: true });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("legal hold");
  });

  const nonLegalHoldKinds: OrganizationSagaKind[] = [
    "ARCHIVE",
    "RESTORE",
    "EXPORT",
    "OWNERSHIP_TRANSFER",
    "PURGE_CANCEL",
    "LEGAL_HOLD",
    "LEGAL_HOLD_RELEASE",
  ];

  it.each(nonLegalHoldKinds)(
    "%s is NOT blocked by a legal hold when fromStatus is valid",
    (kind) => {
      const def = TRANSITION_TABLE[kind];
      const from = def.allowedFrom?.[0] ?? null;
      const result = assertTransitionAllowed(kind, from, { hasActiveLegalHold: true });
      expect(result.allowed).toBe(true);
    },
  );

  it("allows PURGE_SCHEDULE when legal hold is released (false)", () => {
    const result = assertTransitionAllowed("PURGE_SCHEDULE", "ACTIVE", { hasActiveLegalHold: false });
    expect(result.allowed).toBe(true);
  });

  it("allows TERMINAL_DELETE when legal hold is released (false)", () => {
    const result = assertTransitionAllowed("TERMINAL_DELETE", "ACTIVE", { hasActiveLegalHold: false });
    expect(result.allowed).toBe(true);
  });
});

describe("assertTransitionAllowed — from-status matrix", () => {
  const allStatuses: OrgStatus[] = ["ACTIVE", "ARCHIVED", "PURGE_SCHEDULED", "PURGED"];

  const cases: Array<[OrganizationSagaKind, OrgStatus, boolean]> = [
    ["ARCHIVE", "ACTIVE", true],
    ["ARCHIVE", "ARCHIVED", false],
    ["ARCHIVE", "PURGE_SCHEDULED", false],
    ["ARCHIVE", "PURGED", false],

    ["RESTORE", "ARCHIVED", true],
    ["RESTORE", "ACTIVE", false],
    ["RESTORE", "PURGE_SCHEDULED", false],
    ["RESTORE", "PURGED", false],

    ["EXPORT", "ACTIVE", true],
    ["EXPORT", "ARCHIVED", true],
    ["EXPORT", "PURGE_SCHEDULED", false],
    ["EXPORT", "PURGED", false],

    ["OWNERSHIP_TRANSFER", "ACTIVE", true],
    ["OWNERSHIP_TRANSFER", "ARCHIVED", false],

    ["PURGE_SCHEDULE", "ACTIVE", true],
    ["PURGE_SCHEDULE", "ARCHIVED", true],
    ["PURGE_SCHEDULE", "PURGE_SCHEDULED", false],
    ["PURGE_SCHEDULE", "PURGED", false],

    ["PURGE_CANCEL", "PURGE_SCHEDULED", true],
    ["PURGE_CANCEL", "ACTIVE", false],
    ["PURGE_CANCEL", "ARCHIVED", false],

    ["LEGAL_HOLD", "ACTIVE", true],
    ["LEGAL_HOLD", "ARCHIVED", false],

    ["LEGAL_HOLD_RELEASE", "ACTIVE", true],
    ["LEGAL_HOLD_RELEASE", "ARCHIVED", false],

    ["TERMINAL_DELETE", "ACTIVE", true],
    ["TERMINAL_DELETE", "ARCHIVED", true],
    ["TERMINAL_DELETE", "PURGE_SCHEDULED", false],
    ["TERMINAL_DELETE", "PURGED", false],
  ];

  it.each(cases)(
    "%s from %s should be allowed=%s",
    (kind, from, expected) => {
      const result = assertTransitionAllowed(kind, from, { hasActiveLegalHold: false });
      expect(result.allowed).toBe(expected);
    },
  );

  it("CREATE requires fromStatus=null to be allowed", () => {
    const ok = assertTransitionAllowed("CREATE", null, { hasActiveLegalHold: false });
    expect(ok.allowed).toBe(true);
  });

  it.each(allStatuses)("CREATE is refused when org already exists with status %s", (status) => {
    const result = assertTransitionAllowed("CREATE", status, { hasActiveLegalHold: false });
    expect(result.allowed).toBe(false);
  });

  it("non-CREATE kinds are refused when fromStatus is null", () => {
    const nonCreateKinds = Object.keys(TRANSITION_TABLE).filter(
      (k) => k !== "CREATE",
    ) as OrganizationSagaKind[];
    for (const kind of nonCreateKinds) {
      const def = TRANSITION_TABLE[kind];
      if (def.allowedFrom === null) continue;
      const result = assertTransitionAllowed(kind, null, { hasActiveLegalHold: false });
      expect(result.allowed).toBe(false);
    }
  });
});

describe("assertTransitionAllowed — returns a discriminated value, not a throw", () => {
  it("returns { allowed: false, reason: string } for invalid transitions", () => {
    const result = assertTransitionAllowed("ARCHIVE", "PURGED", { hasActiveLegalHold: false });
    expect(result).toEqual({
      allowed: false,
      reason: expect.stringContaining("ARCHIVE"),
    });
  });

  it("returns { allowed: true } for valid transitions", () => {
    const result = assertTransitionAllowed("ARCHIVE", "ACTIVE", { hasActiveLegalHold: false });
    expect(result).toEqual({ allowed: true });
  });
});
