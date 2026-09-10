jest.mock("../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import {
  broadest,
  evaluateMembershipGate,
  isActiveDelegation,
  isActiveAssignment,
  isPlanGatedModule,
  type DelegationRow,
} from "./access-policy";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import type { DataScope } from "./access.types";

describe("broadest", () => {
  it("ranks none < own < team < all", () => {
    expect(broadest("none", "own")).toBe("own");
    expect(broadest("own", "team")).toBe("team");
    expect(broadest("team", "all")).toBe("all");
    expect(broadest("none", "all")).toBe("all");
  });

  it("keeps the broader scope regardless of argument order", () => {
    expect(broadest("all", "own")).toBe("all");
    expect(broadest("own", "all")).toBe("all");
  });

  it("returns the same scope when both are equal", () => {
    const scopes: DataScope[] = ["none", "own", "team", "all"];
    for (const scope of scopes) expect(broadest(scope, scope)).toBe(scope);
  });
});

describe("namespaceOf", () => {
  it("extracts the part before the first colon", () => {
    expect(namespaceOf("hr:employees:view")).toBe("hr");
    expect(namespaceOf("settings:rbac:manage")).toBe("settings");
  });

  it("returns the whole key when there is no colon", () => {
    expect(namespaceOf("accounting")).toBe("accounting");
  });
});

describe("isPlanGatedModule", () => {
  it("gates the modules an organization actually buys and toggles", () => {
    expect(isPlanGatedModule("hr")).toBe(true);
    expect(isPlanGatedModule("crm")).toBe(true);
    expect(isPlanGatedModule("payroll")).toBe(true);
  });

  it("does not gate settings or self", () => {
    expect(isPlanGatedModule("settings")).toBe(false);
    expect(isPlanGatedModule("self")).toBe(false);
  });

  it("does not gate platform infrastructure, which no org can enable", () => {
    for (const module of [
      "directory",
      "party",
      "ownership",
      "onboarding",
      "workforce",
      "notifications",
      "dashboard",
      "billing",
      "branch",
      "audit-log",
    ]) {
      expect(isPlanGatedModule(module)).toBe(false);
    }
  });
});

describe("evaluateMembershipGate", () => {
  it("denies when there is no membership row", () => {
    expect(evaluateMembershipGate(null)).toEqual({ active: false, isOwner: false });
    expect(evaluateMembershipGate(undefined)).toEqual({ active: false, isOwner: false });
  });

  it("denies a suspended member even if the owner flag is set", () => {
    expect(evaluateMembershipGate({ status: "SUSPENDED", isOwner: true })).toEqual({
      active: false,
      isOwner: false,
    });
  });

  it("denies a member who has left", () => {
    expect(evaluateMembershipGate({ status: "LEFT", isOwner: false })).toEqual({
      active: false,
      isOwner: false,
    });
  });

  it("denies an invited-but-not-active member", () => {
    expect(evaluateMembershipGate({ status: "INVITED", isOwner: false })).toEqual({
      active: false,
      isOwner: false,
    });
  });

  it("allows an active member without owner rights", () => {
    expect(evaluateMembershipGate({ status: "ACTIVE", isOwner: false })).toEqual({
      active: true,
      isOwner: false,
    });
  });

  it("allows and flags an active owner", () => {
    expect(evaluateMembershipGate({ status: "ACTIVE", isOwner: true })).toEqual({
      active: true,
      isOwner: true,
    });
  });
});

describe("isActiveDelegation", () => {
  const now = new Date("2026-07-26T12:00:00Z");
  const future = new Date("2026-07-27T12:00:00Z");
  const past = new Date("2026-07-25T12:00:00Z");

  function makeRow(overrides: Partial<DelegationRow> = {}): DelegationRow {
    return {
      permissions: ["hr:leaves:approve"],
      status: "ACTIVE",
      startsAt: past,
      endsAt: future,
      ...overrides,
    };
  }

  it("accepts an ACTIVE delegation whose endsAt is in the future", () => {
    expect(isActiveDelegation(makeRow(), now)).toBe(true);
  });

  it("rejects a delegation with status REVOKED", () => {
    expect(isActiveDelegation(makeRow({ status: "REVOKED" }), now)).toBe(false);
  });

  it("rejects a delegation that has expired (endsAt in the past)", () => {
    expect(isActiveDelegation(makeRow({ endsAt: past }), now)).toBe(false);
  });

  it("rejects a delegation that expires exactly at now (boundary)", () => {
    expect(isActiveDelegation(makeRow({ endsAt: now }), now)).toBe(false);
  });

  it("accepts a delegation that expires one millisecond in the future", () => {
    const almostExpired = new Date(now.getTime() + 1);
    expect(isActiveDelegation(makeRow({ endsAt: almostExpired }), now)).toBe(true);
  });

  it("rejects a delegation that has not started", () => {
    expect(isActiveDelegation(makeRow({ startsAt: future }), now)).toBe(false);
  });

  it("merging an active delegation's permissions into an empty map adds them at all scope", () => {
    const row = makeRow({ permissions: ["hr:leaves:approve", "hr:employees:view"] });
    const result: Record<string, import("./access.types").DataScope> = {};
    if (isActiveDelegation(row, now)) {
      for (const key of row.permissions) {
        const existing = result[key];
        result[key] = existing ? broadest(existing, "all") : "all";
      }
    }
    expect(result).toEqual({ "hr:leaves:approve": "all", "hr:employees:view": "all" });
  });

  it("merging an active delegation does not remove or downgrade existing permissions", () => {
    const result: Record<string, import("./access.types").DataScope> = {
      "hr:leaves:approve": "team",
    };
    const row = makeRow({ permissions: ["hr:leaves:approve"] });
    if (isActiveDelegation(row, now)) {
      for (const key of row.permissions) {
        const existing = result[key];
        result[key] = existing ? broadest(existing, "all") : "all";
      }
    }
    expect(result["hr:leaves:approve"]).toBe("all");
  });

  it("an expired or revoked delegation contributes no permissions to the map", () => {
    const result: Record<string, import("./access.types").DataScope> = {};
    const rows = [
      makeRow({ status: "REVOKED", permissions: ["hr:leaves:approve"] }),
      makeRow({ endsAt: past, permissions: ["hr:employees:view"] }),
    ];
    for (const row of rows) {
      if (isActiveDelegation(row, now)) {
        for (const key of row.permissions) {
          const existing = result[key];
          result[key] = existing ? broadest(existing, "all") : "all";
        }
      }
    }
    expect(result).toEqual({});
  });
});

describe("isActiveAssignment", () => {
  const now = new Date("2026-07-28T12:00:00Z");

  it("grants when expiresAt is null (permanent assignment)", () => {
    expect(isActiveAssignment({ expiresAt: null }, now)).toBe(true);
  });

  it("grants when expiresAt is one millisecond in the future", () => {
    const future = new Date(now.getTime() + 1);
    expect(isActiveAssignment({ expiresAt: future }, now)).toBe(true);
  });

  it("does not grant when expiresAt is in the past (expired assignment)", () => {
    const past = new Date(now.getTime() - 1000);
    expect(isActiveAssignment({ expiresAt: past }, now)).toBe(false);
  });

  it("does not grant when expiresAt equals now (boundary — strict greater-than)", () => {
    expect(isActiveAssignment({ expiresAt: now }, now)).toBe(false);
  });
});
