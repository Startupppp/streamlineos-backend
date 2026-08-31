import { ForbiddenException } from "@nestjs/common";
import {
  OWNER_ONLY_OPERATION_IDS,
  OWNER_ONLY_OPERATIONS,
  assertOwnerOnly,
  holdsOwnerOnly,
  isOwnerOnlyOperation,
} from "./owner-only-operations";
import { agentTokenPrincipal, humanSessionPrincipal } from "../auth/principal";
import type { CurrentUserContext } from "../auth/backend-claims";
import { ORG_MEMBER_ROLES } from "./org-roles";
import { isStructuralOrgAdminContext } from "./is-structural-org-admin";

function ownerCtx(): CurrentUserContext {
  return {
    userId: "u-owner",
    orgId: "org-1",
    role: ORG_MEMBER_ROLES.OWNER,
    isOrgOwner: true,
    sessionId: "s-owner",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

function memberCtx(): CurrentUserContext {
  return {
    userId: "u-member",
    orgId: "org-1",
    role: ORG_MEMBER_ROLES.MEMBER,
    isOrgOwner: false,
    sessionId: "s-member",
    tokenScopes: null,
    principal: humanSessionPrincipal(2, false),
  };
}

function adminCtx(): CurrentUserContext {
  return {
    userId: "u-admin",
    orgId: "org-1",
    role: ORG_MEMBER_ROLES.ORG_ADMIN,
    isOrgOwner: false,
    sessionId: "s-admin",
    tokenScopes: null,
    principal: humanSessionPrincipal(3, false),
  };
}

function agentCtx(): CurrentUserContext {
  return {
    userId: "u-agent",
    orgId: "org-1",
    role: ORG_MEMBER_ROLES.MEMBER,
    isOrgOwner: false,
    sessionId: "s-agent",
    tokenScopes: null,
    principal: agentTokenPrincipal(4, 99, []),
  };
}

function captureForbidden(fn: () => void): ForbiddenException | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ForbiddenException ? e : undefined;
  }
}

describe("owner-only-operations", () => {
  describe("catalog well-formedness", () => {
    it("every entry has a non-empty summary and a non-empty reason", () => {
      for (const def of Object.values(OWNER_ONLY_OPERATIONS)) {
        expect(def.summary.trim()).not.toBe("");
        expect(def.reason.trim()).not.toBe("");
      }
    });
  });

  describe("isOwnerOnlyOperation", () => {
    it.each(OWNER_ONLY_OPERATION_IDS)("returns true for catalogued id: %s", (id) => {
      expect(isOwnerOnlyOperation(id)).toBe(true);
    });

    it("returns false for a plausible non-catalogued id", () => {
      expect(isOwnerOnlyOperation("organization.settings.update")).toBe(false);
    });
  });

  describe("assertOwnerOnly — owner is allowed", () => {
    it.each(OWNER_ONLY_OPERATION_IDS)("does not throw for org owner: %s", (id) => {
      expect(() => assertOwnerOnly(ownerCtx(), id)).not.toThrow();
    });
  });

  describe("assertOwnerOnly — non-owner is denied", () => {
    it.each(OWNER_ONLY_OPERATION_IDS)(
      "throws ForbiddenException with correct payload for plain member: %s",
      (id) => {
        const err = captureForbidden(() => assertOwnerOnly(memberCtx(), id));
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err?.getResponse()).toMatchObject({
          code: "OWNER_ONLY_OPERATION",
          operation: id,
        });
      },
    );

    it.each(OWNER_ONLY_OPERATION_IDS)(
      "throws ForbiddenException for org admin (role = ORG_ADMIN, isOrgOwner = false): %s",
      (id) => {
        const err = captureForbidden(() => assertOwnerOnly(adminCtx(), id));
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err?.getResponse()).toMatchObject({
          code: "OWNER_ONLY_OPERATION",
          operation: id,
        });
      },
    );

    it.each(OWNER_ONLY_OPERATION_IDS)(
      "throws ForbiddenException for agent-token principal: %s",
      (id) => {
        const err = captureForbidden(() => assertOwnerOnly(agentCtx(), id));
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err?.getResponse()).toMatchObject({
          code: "OWNER_ONLY_OPERATION",
          operation: id,
        });
      },
    );
  });

  describe("holdsOwnerOnly agrees with assertOwnerOnly", () => {
    function assertAgreement(actor: CurrentUserContext): void {
      for (const id of OWNER_ONLY_OPERATION_IDS) {
        const threw = captureForbidden(() => assertOwnerOnly(actor, id)) !== undefined;
        expect(holdsOwnerOnly(actor, id)).toBe(!threw);
      }
    }

    it("agrees for org owner across all catalogued ids", () => {
      assertAgreement(ownerCtx());
    });

    it("agrees for plain member across all catalogued ids", () => {
      assertAgreement(memberCtx());
    });

    it("agrees for org admin across all catalogued ids", () => {
      assertAgreement(adminCtx());
    });

    it("agrees for agent-token principal across all catalogued ids", () => {
      assertAgreement(agentCtx());
    });
  });

  describe("isStructuralOrgAdminContext — admin retains non-owner-only operations", () => {
    it("returns true for org owner", () => {
      expect(isStructuralOrgAdminContext(ownerCtx())).toBe(true);
    });

    it("returns true for org admin (ORG_ADMIN role, isOrgOwner false)", () => {
      expect(isStructuralOrgAdminContext(adminCtx())).toBe(true);
    });

    it("returns false for plain member", () => {
      expect(isStructuralOrgAdminContext(memberCtx())).toBe(false);
    });
  });
});
