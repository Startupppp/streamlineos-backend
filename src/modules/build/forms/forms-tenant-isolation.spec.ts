import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { FormsService } from "./forms.service";

describe("FormsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;
  const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

  function makeU(orgId: string): CurrentUserContext {
    return {
      userId: "user-1",
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "s1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, false),
    };
  }

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
    const svc = new FormsService(db, mockAccess, audit);
    await expect(svc.getForm(makeU(ATTACKER_ORG), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for getForm when form not found for different org (cross-tenant isolation)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const db = makeDb(project, null);
    const svc = new FormsService(db, mockAccess, audit);
    await expect(svc.getForm(makeU(ATTACKER_ORG), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns form for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const form = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Form" };
    const db = makeDb(project, form);
    const svc = new FormsService(db, mockAccess, audit);
    const result = await svc.getForm(makeU(OWNER_ORG), 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("FormsService — project-membership gate (BOLA)", () => {
  const audit = { log: jest.fn() } as never;

  function makeAccess(perms: Set<string> = new Set()): AccessService {
    return {
      resolveUserPermissions: jest.fn().mockResolvedValue(perms),
    } as unknown as AccessService;
  }

  function makeU(orgId: string): CurrentUserContext {
    return {
      userId: "user-1",
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "s1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, false),
    };
  }

  function makeSelectChain(rows: unknown[]) {
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    return chain;
  }

  const u = makeU("org-1");

  it("REJECTS a non-member with ForbiddenException", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    } as unknown as Db;
    const svc = new FormsService(mockDb, makeAccess(), audit);

    await expect(svc.listForms(u, 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("ALLOWS a direct project member", async () => {
    const mockDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        projectForms: { findFirst: jest.fn() },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
        .mockReturnValueOnce(makeSelectChain([])),
    } as unknown as Db;
    const svc = new FormsService(mockDb, makeAccess(), audit);

    await expect(svc.listForms(u, 1, {})).resolves.toEqual([]);
  });
});
