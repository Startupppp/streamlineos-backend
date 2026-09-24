import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ClientVisibilityService } from "./client-visibility.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";

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
const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("ClientVisibilityService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when project belongs to a different org", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        tickets: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;

    const svc = new ClientVisibilityService(db, mockAccess, mockAudit);

    await expect(svc.getVisibilitySummary(makeU("org-attacker"), 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when toggling ticket visibility on a different org's project", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
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
  const gateAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  function makeNonMemberDb(): Db {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        }),
    } as unknown as Db;
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
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ role: "MEMBER" }]) }),
            }),
          }),
        })
        .mockReturnValue(listChain),
    } as unknown as Db;
  }

  beforeEach(() => {
    (gateAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

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
