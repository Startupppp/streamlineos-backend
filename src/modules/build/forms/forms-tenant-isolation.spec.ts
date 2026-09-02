import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { FormsService } from "./forms.service";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 100, isOrgOwner: false },
    ...overrides,
  };
}

function makeSelectChain(resolved: unknown[]) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(resolved),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("FormsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;
  const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

  function makeDb(projectRow: unknown | null, formRow: unknown | null = null) {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        projectForms: { findFirst: jest.fn().mockResolvedValue(formRow), findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
  }

  it("throws NotFoundException for getForm when project is from a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new FormsService(db, audit, mockAccess);
    await expect(svc.getForm(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for getForm when form not found for different org (cross-tenant isolation)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const db = makeDb(project, null);
    const svc = new FormsService(db, audit, mockAccess);
    await expect(svc.getForm(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns form for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const form = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Form" };
    const db = makeDb(project, form);
    const svc = new FormsService(db, audit, mockAccess);
    const result = await svc.getForm(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("FormsService — assertProjectAccess gate BITES", () => {
  const audit = { log: jest.fn() } as never;

  it("rejects a non-member caller with ForbiddenException", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(project) },
        projectForms: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new FormsService(mockDb, audit, mockAccess);
    await expect(
      svc.listForms(makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }), 1, {}),
    ).rejects.toThrow(ForbiddenException);
    expect((mockDb as unknown as { transaction: jest.Mock }).transaction).not.toHaveBeenCalled();
  });

  it("allows a direct project member to list forms", async () => {
    const project = { id: 1, orgId: "org-1", managerMembershipId: 999 };
    const mockAccess = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as AccessService;
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(project) },
        projectForms: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce(makeSelectChain([])),
    } as unknown as Db;

    const svc = new FormsService(mockDb, audit, mockAccess);
    const result = await svc.listForms(
      makeUser({ isOrgOwner: false, orgId: "org-1", userId: "user-1" }),
      1,
      {},
    );
    expect(Array.isArray(result)).toBe(true);
  });
});
