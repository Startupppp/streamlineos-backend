import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { WorkflowService } from "./workflow.service";

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

describe("WorkflowService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  function makeDb(projectRow: unknown | null, transitionRows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(transitionRows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      db: {
        query: { projects: { findFirst: jest.fn().mockResolvedValue(projectRow) } },
        select,
      } as unknown as Db,
    };
  }

  beforeEach(() => {
    (access.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("throws NotFoundException for listTransitions when project not in org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null, []);
    const svc = new WorkflowService(db, access, audit);
    await expect(svc.listTransitions(makeU(ATTACKER_ORG), 99)).rejects.toThrow(NotFoundException);
  });

  it("returns transitions for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG, managerMembershipId: 999 };
    const transition = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Start" };
    const { db } = makeDb(project, [transition]);
    const svc = new WorkflowService(db, access, audit);
    const result = await svc.listTransitions(makeU(OWNER_ORG, true), 1);
    expect(result).toHaveLength(1);
  });
});

describe("WorkflowService — project membership gate (BOLA fix)", () => {
  const ORG = "org-1";
  const audit = { log: jest.fn() } as never;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  const u = makeU(ORG);

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
    const postGateChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
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
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        })
        .mockReturnValue(postGateChain),
    } as unknown as Db;
  }

  beforeEach(() => {
    (access.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("rejects non-member with ForbiddenException on listTransitions", async () => {
    const db = makeNonMemberDb();
    const svc = new WorkflowService(db, access, audit);
    await expect(svc.listTransitions(u, 1)).rejects.toThrow(ForbiddenException);
  });

  it("allows direct project member on listTransitions", async () => {
    const db = makeMemberDb();
    const svc = new WorkflowService(db, access, audit);
    await expect(svc.listTransitions(u, 1)).resolves.toBeDefined();
  });
});

describe("WorkflowService — list endpoints respect the 100-row hard cap", () => {
  const ORG = "org-cap";
  const audit = { log: jest.fn() } as never;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;
  const u = makeU(ORG, true);

  it("listTransitions passes 100 as the limit (not 500)", async () => {
    let capturedLimit: number | undefined;
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ORG }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation((n: number) => {
              capturedLimit = n;
              return Promise.resolve([]);
            }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new WorkflowService(db, access, audit);
    await svc.listTransitions(u, 1);
    expect(capturedLimit).toBe(100);
  });

  it("getAllowedTransitions passes 100 as the limit (not 500)", async () => {
    let capturedLimit: number | undefined;
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ORG }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation((n: number) => {
              capturedLimit = n;
              return Promise.resolve([]);
            }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new WorkflowService(db, access, audit);
    await svc.getAllowedTransitions(u, 1, 5);
    expect(capturedLimit).toBe(100);
  });
});

describe("WorkflowService — wrong-project or cross-tenant statusId returns 404 not 400", () => {
  const ORG = "org-404-test";
  const audit = { log: jest.fn() } as never;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;
  const u = makeU(ORG, true);

  it("createTransition throws NotFoundException (not BadRequestException) when toStatusId is not in the project", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ORG, managerMembershipId: null }) },
        projectStatuses: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const svc = new WorkflowService(db, access, audit);
    await expect(
      svc.createTransition(u, 1, { toStatusId: 99 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateWipLimit throws NotFoundException (not BadRequestException) when statusId is not in the project", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ORG, managerMembershipId: null }) },
        projectStatuses: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const svc = new WorkflowService(db, access, audit);
    await expect(
      svc.updateWipLimit(u, 1, 99, { wipLimit: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
