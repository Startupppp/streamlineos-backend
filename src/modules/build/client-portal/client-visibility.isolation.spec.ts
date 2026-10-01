import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ClientVisibilityService } from "./client-visibility.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import {
  MEMBER_STANDING,
  projectAccessRow,
  type ProjectAccessRow,
} from "../core/project-crud/__tests__/project-access-doubles";

function projectGateSelect(rows: ProjectAccessRow[], rest: jest.Mock = jest.fn()): jest.Mock {
  return jest.fn((fields?: Record<string, unknown>) =>
    fields !== undefined && "manages" in fields
      ? { from: () => ({ where: () => ({ limit: async () => rows }) }) }
      : rest(fields),
  );
}


const memberScopeAccess = {
  scopeFor: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner ? "all" : (MEMBER_STANDING[key] ?? "none"),
  holds: async (actor: CurrentUserContext, key: string) =>
    actor.isOrgOwner || (MEMBER_STANDING[key] ?? "none") !== "none",
} as unknown as AccessService;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = memberScopeAccess;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ClientVisibilityService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when project belongs to a different org", async () => {
    const db = {
      query: {
        tickets: { findFirst: jest.fn() },
      },
      select: projectGateSelect([]),
      update: jest.fn(),
    } as unknown as Db;

    const svc = new ClientVisibilityService(db, mockAccess, mockAudit);

    await expect(svc.getVisibilitySummary(makeU("org-attacker"), 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when toggling ticket visibility on a different org's project", async () => {
    const db = {
      query: {
        tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: projectGateSelect([]),
      update: jest.fn(),
    } as unknown as Db;

    const svc = new ClientVisibilityService(db, mockAccess, mockAudit);

    await expect(
      svc.toggleTicketVisibility(makeU("org-attacker"), 1, 99, true),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("ClientVisibilityService — project membership gate (BOLA fix)", () => {
  const ORG = "org-1";
  const u = makeU(ORG);
  const gateAccess = memberScopeAccess;

  function makeNonMemberDb(): Db {
    return { select: projectGateSelect([projectAccessRow()]) } as unknown as Db;
  }

  function makeMemberDb(): Db {
    const listChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      select: projectGateSelect([projectAccessRow({ memberRole: "MEMBER" })], jest.fn().mockReturnValue(listChain)),
    } as unknown as Db;
  }

  it("rejects non-member with ForbiddenException on getVisibilitySummary", async () => {
    const db = makeNonMemberDb();
    const svc = new ClientVisibilityService(db, gateAccess, mockAudit);
    await expect(svc.getVisibilitySummary(u, 1)).rejects.toThrow(ForbiddenException);
  });

  it("allows direct project member on getVisibilitySummary", async () => {
    const db = makeMemberDb();
    const svc = new ClientVisibilityService(db, gateAccess, mockAudit);
    await expect(svc.getVisibilitySummary(u, 1)).resolves.toBeDefined();
  });

  it.each([
    ["ticket", (svc: ClientVisibilityService) => svc.toggleTicketVisibility(u, 1, 99, true)],
    ["milestone", (svc: ClientVisibilityService) => svc.toggleMilestoneVisibility(u, 1, 99, true)],
    ["comment", (svc: ClientVisibilityService) => svc.toggleCommentVisibility(u, 1, 99, true)],
    ["attachment", (svc: ClientVisibilityService) => svc.toggleAttachmentVisibility(u, 1, 99, true)],
  ])("rejects a non-member before changing %s visibility", async (_resource, toggle) => {
    const db = makeNonMemberDb();
    const svc = new ClientVisibilityService(db, gateAccess, mockAudit);

    await expect(toggle(svc)).rejects.toThrow(ForbiddenException);
  });
});
