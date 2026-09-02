import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestRunsService } from "./test-runs.service";

const MEMBERSHIP_ID = 7;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, isOrgOwner),
  };
}

describe("TestRunsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(runRow: unknown | null) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        testRuns: { findFirst: jest.fn().mockResolvedValue(runRow) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  function makeAccess() {
    return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
  }

  it("throws NotFoundException for getRun when run belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new TestRunsService(db, makeAccess(), audit);
    await expect(svc.getRun(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns run for the owning org (same-tenant control)", async () => {
    const run = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Run 1" };
    const db = makeDb(run);
    const svc = new TestRunsService(db, makeAccess(), audit);
    const result = await svc.getRun(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe("TestRunsService — project membership gate (assertProjectAccess)", () => {
  const audit = { log: jest.fn() } as never;

  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testRuns: { findFirst: jest.fn() },
        testRunResults: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  function makeMemberDb() {
    let callCount = 0;
    const makeLimitChain = (rows: unknown[]) => {
      const limit = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ limit });
      const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
      return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
    };
    const runsChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testRuns: { findFirst: jest.fn() },
        testRunResults: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? makeLimitChain([{ role: "MEMBER" }]) : runsChain;
      }),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestRunsService(db, access, audit);
    await expect(svc.listRuns(makeU("org-1"), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestRunsService(db, access, audit);
    await expect(svc.listRuns(makeU("org-1"), 1, {})).resolves.toEqual([]);
  });
});
