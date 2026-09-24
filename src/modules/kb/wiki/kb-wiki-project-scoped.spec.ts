import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";
import { KbPageTreeService } from "./kb-page-tree.service";

jest.mock("../../build/core/project-access", () => ({
  resolveProjectAccess: jest.fn(),
}));

import { resolveProjectAccess } from "../../build/core/project-access";
const mockResolveProjectAccess = resolveProjectAccess as jest.Mock;

function makeUser(orgId = "org-a") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 10 },
  } as never;
}

function makeSearchDb(rows: unknown[]) {
  const fromChain = {
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
  return {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(fromChain) }),
  } as unknown as Db;
}

function makeTreeDb(rows: unknown[]) {
  const fromChain = {
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
  return {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(fromChain) }),
  } as unknown as Db;
}

const stubAuth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue(undefined),
  resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed", via: "project" }),
};

const STUB_ACCESS = {} as never;

describe("KbPagesService.search — project-scoped membership enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubAuth.visiblePagePredicate.mockResolvedValue(sql`true`);
  });

  it("throws NotFoundException when caller is not a project member (non-member denied)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const db = makeSearchDb([]);
    const svc = new KbPagesService(db, {} as never, {} as never, stubAuth as never, STUB_ACCESS);

    await expect(svc.search(makeUser(), "test", 10, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns search results when caller is a project member (member allowed)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const db = makeSearchDb([
      { id: 1, title: "Page 1", icon: null, snippet: "match" },
    ]);
    const svc = new KbPagesService(db, {} as never, {} as never, stubAuth as never, STUB_ACCESS);

    const result = await svc.search(makeUser(), "test", 10, 99);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 1, title: "Page 1" });
  });

  it("does not call resolveProjectAccess when projectId is omitted (global search)", async () => {
    const db = makeSearchDb([]);
    const svc = new KbPagesService(db, {} as never, {} as never, stubAuth as never, STUB_ACCESS);

    await svc.search(makeUser(), "test", 10);

    expect(mockResolveProjectAccess).not.toHaveBeenCalled();
  });

  it("cross-tenant: project access check receives the calling org, not the project's org", async () => {
    const ATTACKER_ORG = "org-attacker";
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const db = makeSearchDb([]);
    const svc = new KbPagesService(db, {} as never, {} as never, stubAuth as never, STUB_ACCESS);

    await expect(svc.search(makeUser(ATTACKER_ORG), "test", 10, 99)).rejects.toThrow(NotFoundException);

    const callUser = mockResolveProjectAccess.mock.calls[0]?.[2] as { orgId: string } | undefined;
    expect(callUser?.orgId).toBe(ATTACKER_ORG);
  });
});

describe("KbPageTreeService.getTree — project-scoped membership enforcement", () => {
  const audit = { log: jest.fn() } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    stubAuth.visiblePagePredicate.mockResolvedValue(sql`true`);
  });

  it("throws NotFoundException when caller is not a project member (non-member denied)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const db = makeTreeDb([]);
    const svc = new KbPageTreeService(db, audit, stubAuth as never, STUB_ACCESS);

    await expect(svc.getTree(makeUser(), 99)).rejects.toThrow(NotFoundException);
  });

  it("returns tree rows when caller is a project member (member allowed)", async () => {
    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const db = makeTreeDb([
      {
        id: 1,
        parentPageId: null,
        spaceId: null,
        projectId: 99,
        title: "Root page",
        icon: null,
        coverImage: null,
        sortOrder: 100,
        visibility: "org",
        createdById: "user-1",
        status: "published",
        updatedAt: new Date(),
      },
    ]);
    const svc = new KbPageTreeService(db, audit, stubAuth as never, STUB_ACCESS);

    const result = await svc.getTree(makeUser(), 99);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, projectId: 99 });
  });

  it("skips project access check when projectId is omitted (global tree)", async () => {
    const db = makeTreeDb([]);
    const svc = new KbPageTreeService(db, audit, stubAuth as never, STUB_ACCESS);

    await svc.getTree(makeUser());

    expect(mockResolveProjectAccess).not.toHaveBeenCalled();
  });

  it("cross-tenant: project access check receives the calling user, so a different org user gets 404", async () => {
    const OWNER_ORG = "org-owner";
    const ATTACKER_ORG = "org-attacker";
    mockResolveProjectAccess
      .mockImplementation((_db: unknown, _access: unknown, user: { orgId: string }) =>
        Promise.resolve({ hasAccess: user.orgId === OWNER_ORG, role: null }),
      );

    const db = makeTreeDb([]);
    const svc = new KbPageTreeService(db, audit, stubAuth as never, STUB_ACCESS);

    await expect(svc.getTree(makeUser(ATTACKER_ORG), 99)).rejects.toThrow(NotFoundException);

    mockResolveProjectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const ownerResult = await svc.getTree(makeUser(OWNER_ORG), 99);
    expect(ownerResult).toHaveLength(0);
  });
});
