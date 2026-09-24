import { Test } from "@nestjs/testing";
import { ToolAccessService } from "./tool-access.service";
import { AccessService } from "../../access/access.service";
import { resolvePrincipalScope } from "../../access/access-principal-scope";
import type { DataScope } from "../../access/access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  ACCOUNT_ONLY_PRINCIPAL,
  agentTokenPrincipal,
  humanSessionPrincipal,
  personalTokenPrincipal,
  type Principal,
} from "../../../common/auth/principal";

const TICKETS = "build:tickets:view";

/**
 * Mirrors AccessService.scopeFor exactly: resolvePrincipalScope wrapping a
 * membership lookup that answers "all" for an owner and the resolved map
 * otherwise. Using the real resolvePrincipalScope is the point — a mock of it
 * could not catch a caller that skips it.
 */
function makeAccess(perms: Record<string, DataScope>) {
  const resolveUserPermissions = jest
    .fn()
    .mockResolvedValue(new Map(Object.entries(perms)));
  return {
    resolveUserPermissions,
    scopeFor: jest.fn(async (user: CurrentUserContext, key: string) =>
      resolvePrincipalScope(user.principal, key, async (isOrgOwner) =>
        isOrgOwner ? "all" : (perms[key] ?? "none"),
      ),
    ),
  };
}

function actorWith(principal: Principal): CurrentUserContext {
  return {
    userId: "user1",
    orgId: "org1",
    role: "MEMBER",
    isOrgOwner: principal.kind === "human-session" && principal.isOrgOwner,
    sessionId: "session1",
    tokenScopes: null,
    principal,
  };
}

async function buildService(perms: Record<string, DataScope>) {
  const access = makeAccess(perms);
  const module = await Test.createTestingModule({
    providers: [ToolAccessService, { provide: AccessService, useValue: access }],
  }).compile();
  return { svc: module.get(ToolAccessService), access };
}

describe("ToolAccessService", () => {
  describe("a human session resolves its membership capability", () => {
    it("returns null for an allowed scope", async () => {
      const { svc } = await buildService({ [TICKETS]: "all" });
      const reason = await svc.denyReason(
        actorWith(humanSessionPrincipal(1, false)),
        TICKETS,
      );
      expect(reason).toBeNull();
    });

    it("returns a denial string for a key the member does not hold", async () => {
      const { svc } = await buildService({ [TICKETS]: "all" });
      const reason = await svc.denyReason(
        actorWith(humanSessionPrincipal(1, false)),
        "hr:payroll:view",
      );
      expect(reason).toContain("Permission denied");
    });

    it("reports scope 'own' for an own-scoped permission", async () => {
      const { svc } = await buildService({ "crm:leads:view": "own" });
      const read = await svc.scope(
        actorWith(humanSessionPrincipal(1, false)),
        "crm:leads:view",
      );
      expect(read.denied).toBe(false);
      expect(read.unrestricted).toBe(false);
      expect(read.rawScope("spec reads the resolved value")).toBe("own");
    });

    it("an org owner resolves 'all' without holding the key in the map", async () => {
      const { svc } = await buildService({});
      const read = await svc.scope(
        actorWith(humanSessionPrincipal(1, true)),
        TICKETS,
      );
      expect(read.rawScope("spec reads the resolved value")).toBe("all");
    });
  });

  describe("a token principal is clamped to its ceiling", () => {
    it("denies a personal token whose ceiling excludes the key, even though the member holds it", async () => {
      const { svc } = await buildService({ [TICKETS]: "all" });
      const read = await svc.scope(
        actorWith(personalTokenPrincipal(1, false, "tok1", ["crm:leads:view"])),
        TICKETS,
      );
      expect(read.denied).toBe(true);
      expect(read.rawScope("spec reads the resolved value")).toBe("none");
    });

    it("allows a personal token whose ceiling includes the key", async () => {
      const { svc } = await buildService({ [TICKETS]: "all" });
      const read = await svc.scope(
        actorWith(personalTokenPrincipal(1, false, "tok1", [TICKETS])),
        TICKETS,
      );
      expect(read.denied).toBe(false);
    });

    it("denies a personal token for a non-delegable key even when the ceiling names it", async () => {
      const { svc } = await buildService({ "settings:rbac:manage": "all" });
      const read = await svc.scope(
        actorWith(
          personalTokenPrincipal(1, true, "tok1", ["settings:rbac:manage"]),
        ),
        "settings:rbac:manage",
      );
      expect(read.denied).toBe(true);
    });

    it("denies an agent token whose ceiling excludes the key", async () => {
      const { svc } = await buildService({ [TICKETS]: "all" });
      const read = await svc.scope(
        actorWith(agentTokenPrincipal(1, 7, ["crm:leads:view"])),
        TICKETS,
      );
      expect(read.denied).toBe(true);
    });

    it("never grants an agent token owner standing", async () => {
      const { svc } = await buildService({});
      const read = await svc.scope(
        actorWith(agentTokenPrincipal(1, 7, [TICKETS])),
        TICKETS,
      );
      expect(read.rawScope("spec reads the resolved value")).toBe("none");
    });

    it("denies an account-only principal every key", async () => {
      const { svc } = await buildService({ [TICKETS]: "all" });
      const read = await svc.scope(actorWith(ACCOUNT_ONLY_PRINCIPAL), TICKETS);
      expect(read.denied).toBe(true);
    });
  });

  it("resolves through scopeFor, never through resolveUserPermissions directly", async () => {
    const { svc, access } = await buildService({ [TICKETS]: "all" });
    await svc.scope(actorWith(humanSessionPrincipal(1, false)), TICKETS);
    expect(access.scopeFor).toHaveBeenCalledTimes(1);
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });
});
