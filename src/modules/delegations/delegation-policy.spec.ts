import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import {
  assertDelegationPolicy,
  assertDelegationTarget,
} from "./delegation-policy";
import { DelegationsService } from "./delegations.service";

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

describe("assertDelegationPolicy", () => {
  const now = new Date("2026-08-03T12:00:00Z");

  it("loads the delegation service with its policy dependencies", () => {
    expect(DelegationsService).toBeDefined();
  });

  it("rejects unknown catalog permissions", () => {
    expect(() =>
      assertDelegationPolicy(
        actor,
        new Map<string, DataScope>(),
        ["unknown:resource:view"],
        now,
        new Date("2026-08-04T12:00:00Z"),
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects permissions the delegator cannot grant", () => {
    expect(() =>
      assertDelegationPolicy(
        actor,
        new Map<string, DataScope>(),
        ["hr:employees:view"],
        now,
        new Date("2026-08-04T12:00:00Z"),
        now,
      ),
    ).toThrow(ForbiddenException);
  });

  it("rejects scoped permissions because delegations grant all scope", () => {
    expect(() =>
      assertDelegationPolicy(
        actor,
        new Map([["hr:employees:view", "own"]]),
        ["hr:employees:view"],
        now,
        new Date("2026-08-04T12:00:00Z"),
        now,
      ),
    ).toThrow(ForbiddenException);
  });

  it("rejects a delegation that ends before it starts", () => {
    expect(() =>
      assertDelegationPolicy(
        actor,
        new Map([["hr:employees:view", "all"]]),
        ["hr:employees:view"],
        new Date("2026-08-05T12:00:00Z"),
        new Date("2026-08-04T12:00:00Z"),
        now,
      ),
    ).toThrow(BadRequestException);
  });
});

describe("assertDelegationTarget", () => {
  it("rejects a self-delegation", () => {
    expect(() => assertDelegationTarget("user-1", "user-1")).toThrow(
      BadRequestException,
    );
  });

  it("accepts another organization member", () => {
    expect(() => assertDelegationTarget("user-1", "user-2")).not.toThrow();
  });
});
