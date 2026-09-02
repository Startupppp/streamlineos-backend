import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ClientVisibilityService } from "./client-visibility.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeUser(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

function makeAccess(permissions: string[]): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(permissions)),
  } as unknown as AccessService;
}

function makeDb(options: {
  project: { managerMembershipId: number | null } | undefined;
  memberRows?: unknown[];
  teamRows?: unknown[];
}): Db {
  const results = [options.memberRows ?? [], options.teamRows ?? []];
  let call = 0;
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(options.project) },
      tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn(() => {
      const index = call;
      call++;
      const chain: Record<string, unknown> = {};
      chain["from"] = jest.fn(() => chain);
      chain["innerJoin"] = jest.fn(() => chain);
      chain["where"] = jest.fn(() => chain);
      chain["limit"] = jest.fn(() => Promise.resolve(results[index] ?? []));
      chain["orderBy"] = jest.fn(() => chain);
      return chain;
    }),
    update: jest.fn(),
  } as unknown as Db;
}

describe("ClientVisibilityService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when project belongs to a different org", async () => {
    const svc = new ClientVisibilityService(
      makeDb({ project: undefined }),
      mockAudit,
      makeAccess(["build:manage"]),
    );

    await expect(
      svc.getVisibilitySummary(makeUser("org-attacker"), 99),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when toggling ticket visibility on a different org's project", async () => {
    const svc = new ClientVisibilityService(
      makeDb({ project: undefined }),
      mockAudit,
      makeAccess(["build:manage"]),
    );

    await expect(
      svc.toggleTicketVisibility("org-attacker", "user-1", 1, 99, true),
    ).rejects.toThrow(NotFoundException);
  });

  it("denies a same-org non-member without build:manage (project membership gate)", async () => {
    const svc = new ClientVisibilityService(
      makeDb({ project: { managerMembershipId: 999 }, memberRows: [], teamRows: [] }),
      mockAudit,
      makeAccess(["build:clientvisibility:manage"]),
    );

    await expect(svc.getVisibilitySummary(makeUser("org-a"), 5)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("allows a direct project member without build:manage", async () => {
    const svc = new ClientVisibilityService(
      makeDb({ project: { managerMembershipId: 999 }, memberRows: [{ role: "MEMBER" }] }),
      mockAudit,
      makeAccess(["build:clientvisibility:manage"]),
    );

    const result = await svc.getVisibilitySummary(makeUser("org-a"), 5);
    expect(result).toEqual({ tickets: [], milestones: [] });
  });
});
